# Dragonify

This is a small utility for TrueNAS SCALE 24.10 (Electric Eel) which configures the Docker networking for TrueNAS-managed apps to allow them to communicate with each other, as was in 24.04 (Dragonfish). It will also add a DNS alias in the format `{service}.ix-{app-name}.svc.cluster.local` for each service to ensure backward-compatibility with the old Kubernetes-based apps system.
It can also add a host gateway alias (default: `host-gateway.svc.cluster.local`) for each app container so containers can reach the host via a stable DNS name.

It's a stop-gap until inter-app networking is [properly implemented in Fangtooth](https://forums.truenas.com/t/inter-app-communication-in-24-10-electric-eel/22054).

> [!WARNING]  
> Dragonify introduces functionality that is unsupported by iXsystems. If you are having problems with your TrueNAS installation or its apps, please try stopping Dragonify and restarting all apps to see if the problem persists.

## Installation

1. Go to "Apps" in the TrueNAS SCALE web UI.
2. Click "Discover Apps".
3. Click **⋮** in the top-right corner, then "Install via YAML".
4. Set the name to `dragonify`, and paste the following YAML into the text box.

```yaml
services:
  dragonify:
    image: ghcr.io/tjhorner/dragonify:main
    restart: always
    environment:
      LOG_LEVEL: info # change to debug for more verbose logging
      ENABLE_HOST_GATEWAY_ALIAS: "true" # set to "false" to disable host gateway alias injection
      HOST_GATEWAY_ALIASES: host-gateway.svc.cluster.local # comma or whitespace separated aliases
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

Once started, all of your apps will now be connected on the same Docker network with DNS aliases for each service.

## Technical Details

To facilitate inter-app communication, Dragonify creates a new Docker bridge network called `apps-internal`. It connects all existing TrueNAS-managed containers to the network, then starts listening for new containers to be started. When a new container is started, Dragonify will automatically connect it to the `apps-internal` network.

When host gateway aliases are enabled, Dragonify also writes alias entries to each app container's `/etc/hosts`, mapping aliases (for example `host-gateway.svc.cluster.local`) to the `apps-internal` bridge gateway IP.

It is essentially running this command automatically for you (using postgres as an example):

```sh
docker network connect apps-internal --alias postgres.ix-postgres.svc.cluster.local ix-postgres-postgres-1
```

## License

MIT
