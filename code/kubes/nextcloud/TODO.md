# Nextcloud Kubernetes TODOs & Notes

This document tracks outstanding tasks and architectural decisions for the Nextcloud deployment on `isis.xinutec.org`.

## AppAPI & External Apps (Ex-Apps)

The Nextcloud AppAPI allows running apps (like AI assistants, face recognition, etc.) in separate containers. Because Nextcloud runs in Kubernetes, we cannot let Nextcloud spin up its own Docker containers natively.

### 1. Clear the AppAPI Warning (Pending)
To tell Nextcloud that we are managing containers via Kubernetes, we need to register the "Manual Install" deploy daemon. This fulfills the AppAPI framework requirements and clears the "deploy daemon is not set" warning.

**Command to run (inside the nextcloud pod):**
```bash
php occ app_api:daemon:register manual_install "Manual Install" "manual-install" "http" "" "https://isis.xinutec.org" --set-default
```

### 2. How to Install Ex-Apps in the Future
If you want to install an External App from the Nextcloud App Store, you cannot use the "One-Click Install" button. Instead, follow this Kubernetes-native workflow:

1. **Find the Docker image:** Locate the container image for the Ex-App you want to install.
2. **Write Manifests:** Create a standard Kubernetes `Deployment` and `Service` for the Ex-App.
3. **Save Manifests:** Save these YAML files in this directory alongside `nextcloud-server.yaml`.
4. **Deploy:** Apply the manifests to the cluster (`kubectl apply -f <your-exapp>.yaml`).
5. **Register the App:** Tell Nextcloud where the service is running by executing this inside the Nextcloud pod:
   ```bash
   php occ app_api:app:register <app-name> manual_install --info-xml "http://<exapp-service-name>.nextcloud.svc.cluster.local/info.xml"
   ```

## Nextcloud Talk High-Performance Backend (HPB)

Currently, Nextcloud Talk uses peer-to-peer WebRTC via PHP, which is limited to 2-3 participants. To support larger calls, the Nextcloud Talk High-Performance Backend (Spreed Signaling Server) must be deployed.

### Architecture
Deploying the HPB in Kubernetes requires 4 separate microservices:

1. **NATS Server:** A message broker for internal service communication.
2. **Janus WebRTC Gateway:** The Selective Forwarding Unit (SFU) that routes the actual video/audio streams.
3. **Spreed Signaling Server:** The main controller (`strukturag/nextcloud-spreed-signaling`) that orchestrates Nextcloud, NATS, and Janus.
4. **Coturn (TURN/STUN):** Required for NAT traversal so clients behind strict firewalls can connect to the video streams.

### Deployment Steps
1. Write Kubernetes `Deployment` and `Service` manifests for NATS, Janus, Signaling Server, and Coturn.
2. Apply these to the `nextcloud` namespace.
3. Configure the Shared Secret between the Signaling Server and Nextcloud.
4. In Nextcloud: go to **Administration Settings -> Talk** and configure the High-performance backend URL and the TURN server credentials.
