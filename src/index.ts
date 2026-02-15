import Docker from "dockerode"
import { getEventStream } from "./docker-events"
import { logger } from "./logger"

const NETWORK_NAME = "apps-internal"
const DEFAULT_HOST_GATEWAY_ALIASES = [ "host-gateway.svc.cluster.local" ]

type HostGatewayConfig = {
  enabled: boolean
  aliases: string[]
  gatewayIp?: string
}

async function setUpNetwork(docker: Docker) {
  logger.info(`Setting up network ${NETWORK_NAME}`)

  const existingNetworks = await docker.listNetworks({filters: {name: [NETWORK_NAME]}})
  if (existingNetworks.length === 1) {
    logger.info("Network already exists")
    return
  }

  await docker.createNetwork({
    Name: NETWORK_NAME,
    Driver: "bridge",
    Internal: true,
  })

  logger.info("Network created")
}

function getDnsName(container: Docker.ContainerInfo) {
  const service = container.Labels["com.docker.compose.service"]
  const project = container.Labels["com.docker.compose.project"]
  return `${service}.${project}.svc.cluster.local`
}

function prohibitedNetworkMode(networkMode: string) {
  return [ "none", "host" ].includes(networkMode) ||
    networkMode.startsWith("container:") ||
    networkMode.startsWith("service:")
}

function parseHostGatewayAliases(value?: string) {
  if (!value) {
    return DEFAULT_HOST_GATEWAY_ALIASES
  }

  const aliases = value
    .split(/[,\s]+/)
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0)

  return aliases.length > 0 ? aliases : DEFAULT_HOST_GATEWAY_ALIASES
}

function getHostGatewayConfigFromEnv(): HostGatewayConfig {
  const enabled = (process.env.ENABLE_HOST_GATEWAY_ALIAS ?? "true").toLowerCase() !== "false"
  const aliases = parseHostGatewayAliases(process.env.HOST_GATEWAY_ALIASES)

  return {
    enabled,
    aliases
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function getAppsNetworkGatewayIp(docker: Docker) {
  const network = docker.getNetwork(NETWORK_NAME)
  const details = await network.inspect()
  const ipamConfigs = details.IPAM?.Config as Array<{ Gateway?: string }> | undefined
  return ipamConfigs?.find((config: { Gateway?: string }) => config.Gateway)?.Gateway
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function runContainerExec(container: Docker.Container, command: string[]) {
  const exec = await container.exec({
    Cmd: command,
    User: "0",
    AttachStderr: false,
    AttachStdout: false
  })

  await exec.start({ Detach: true, Tty: false })

  while (true) {
    const info = await exec.inspect()
    if (!info.Running) {
      return info.ExitCode ?? 1
    }

    await sleep(100)
  }
}

async function runShellScriptInContainer(container: Docker.Container, script: string) {
  const shellCandidates = [
    [ "/bin/sh", "-c", script ],
    [ "sh", "-c", script ],
    [ "/bin/ash", "-c", script ],
    [ "ash", "-c", script ],
  ]

  for (const command of shellCandidates) {
    try {
      const exitCode = await runContainerExec(container, command)
      if (exitCode === 0) {
        return true
      }

      logger.debug(`Shell command failed with exit code ${exitCode}: ${command.join(" ")}`)
    } catch {
      logger.debug(`Shell command is unavailable: ${command.join(" ")}`)
      continue
    }
  }

  return false
}

async function ensureHostGatewayAliasesForContainer(docker: Docker, container: Docker.ContainerInfo, hostGatewayConfig: HostGatewayConfig) {
  if (!hostGatewayConfig.enabled || !hostGatewayConfig.gatewayIp) {
    return
  }

  const containerRef = docker.getContainer(container.Id)
  const script = hostGatewayConfig.aliases
    .map((alias) => {
      const escapedAlias = escapeRegex(alias)
      return `grep -Eq '(^|[[:space:]])${escapedAlias}([[:space:]]|$)' /etc/hosts || echo "${hostGatewayConfig.gatewayIp} ${alias}" >> /etc/hosts`
    })
    .join("\n")

  const success = await runShellScriptInContainer(containerRef, script)
  if (!success) {
    logger.warn(
      `Failed to add host gateway aliases (${hostGatewayConfig.aliases.join(", ")}) to container ${container.Id}`
    )
    return
  }

  logger.debug(
    `Ensured host gateway aliases (${hostGatewayConfig.aliases.join(", ")}) for container ${container.Id}`
  )
}

async function connectContainerToAppsNetwork(docker: Docker, container: Docker.ContainerInfo) {
  if (prohibitedNetworkMode(container.HostConfig.NetworkMode)) {
    logger.debug(`Container ${container.Id} is using network mode ${container.HostConfig.NetworkMode}, skipping`)
    return
  }

  const network = docker.getNetwork(NETWORK_NAME)
  const dnsName = getDnsName(container)

  logger.debug(`Connecting container ${container.Id} to network as ${dnsName}`)

  try {
    await network.connect({
      Container: container.Id,
      EndpointConfig: {
        Aliases: [ dnsName ]
      }
    })
  } catch (e: any) {
    logger.error(`Failed to connect container ${container.Id} to network:`, e)
    return
  }

  logger.info(`Container ${container.Id} (aka ${container.Names.join(", ")}) connected to network as ${dnsName}`)
}

function isContainerInNetwork(container: Docker.ContainerInfo) {
  return container.NetworkSettings.Networks[NETWORK_NAME] !== undefined
}

function isIxProjectName(name: string) {
  return name.startsWith("ix-")
}

function isIxAppContainer(container: Docker.ContainerInfo) {
  return isIxProjectName(container.Labels["com.docker.compose.project"])
}

async function connectAllContainersToAppsNetwork(docker: Docker, hostGatewayConfig: HostGatewayConfig) {
  logger.debug("Connecting existing app containers to network")

  const containers = await docker.listContainers({
    limit: -1,
    filters: {
      label: [ "com.docker.compose.project" ]
    }
  })

  const appContainers = containers.filter(isIxAppContainer)
  for (const container of appContainers) {
    const dnsName = getDnsName(container)
    if (isContainerInNetwork(container)) {
      logger.info(`Container ${container.Id} (aka ${container.Names.join(", ")}) already connected to network as ${dnsName}`)
      await ensureHostGatewayAliasesForContainer(docker, container, hostGatewayConfig)
      continue
    }

    await connectContainerToAppsNetwork(docker, container)
    await ensureHostGatewayAliasesForContainer(docker, container, hostGatewayConfig)
  }

  logger.info("All existing app containers connected to network")
}

async function connectNewContainerToAppsNetwork(docker: Docker, containerId: string, hostGatewayConfig: HostGatewayConfig) {
  const [ container ] = await docker.listContainers({
    filters: {
      id: [ containerId ]
    }
  })

  if (!container) {
    logger.warn(`Container ${containerId} not found`)
    return
  }

  const dnsName = getDnsName(container)
  if (isContainerInNetwork(container)) {
    logger.info(`Container ${container.Id} (aka ${container.Names.join(", ")}) already connected to network as ${dnsName}`)
    await ensureHostGatewayAliasesForContainer(docker, container, hostGatewayConfig)
    return
  }

  logger.debug(`New container started: ${container.Id}`)
  await connectContainerToAppsNetwork(docker, container)
  await ensureHostGatewayAliasesForContainer(docker, container, hostGatewayConfig)
}

async function main() {
  const docker = new Docker()
  const hostGatewayConfig = getHostGatewayConfigFromEnv()

  await setUpNetwork(docker)
  if (hostGatewayConfig.enabled) {
    hostGatewayConfig.gatewayIp = await getAppsNetworkGatewayIp(docker)
    if (!hostGatewayConfig.gatewayIp) {
      logger.warn("Host gateway alias is enabled, but apps-internal gateway IP could not be determined")
    } else {
      logger.info(
        `Host gateway alias enabled: ${hostGatewayConfig.aliases.join(", ")} -> ${hostGatewayConfig.gatewayIp}`
      )
    }
  }

  await connectAllContainersToAppsNetwork(docker, hostGatewayConfig)

  const events = getEventStream(docker)
  events.on("container.start", (event) => {
    const containerAttributes = event.Actor.Attributes
    if (!isIxProjectName(containerAttributes["com.docker.compose.project"])) {
      return
    }

    connectNewContainerToAppsNetwork(docker, event.Actor["ID"], hostGatewayConfig)
  })
}

main()
