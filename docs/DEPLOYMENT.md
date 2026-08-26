# Deployment

Use one of two Volcengine ECS paths:

- Install and deploy to an existing Linux ECS instance.
- Provision the complete network and ECS stack with Terraform.

Both profiles require a Volcengine Ark API key and a Responses-capable endpoint.

## Existing Linux ECS

Recommended host:

- Ubuntu 22.04/24.04, Debian 12, or veLinux 2
- 2 vCPU, 4 GiB memory, and a 40 GiB system disk
- Docker Engine 24+ and the Docker Compose plugin

The procedure was verified from a clean veLinux 2 host with Docker Engine
29.6.2 and Compose 5.3.1. Debian 10 is unsupported.

### Install Docker

Install prerequisites:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git openssl
```

Select the Docker repository. veLinux 2 uses Debian 12 Bookworm:

```bash
. /etc/os-release
case "$ID" in
  ubuntu|debian)
    DOCKER_DISTRO="$ID"
    DOCKER_CODENAME="$VERSION_CODENAME"
    ;;
  velinux)
    DOCKER_DISTRO=debian
    DOCKER_CODENAME=bookworm
    ;;
  *)
    echo "Use the Docker-supported parent distribution."
    exit 1
    ;;
esac
```

Download the signing key and compare its full fingerprint with the official
[Docker installation guide](https://docs.docker.com/engine/install/):

```bash
curl -fsSL "https://download.docker.com/linux/$DOCKER_DISTRO/gpg" \
  -o /tmp/docker.asc
gpg --show-keys --with-fingerprint /tmp/docker.asc
```

After verification, install Docker:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo gpg --batch --yes --dearmor \
  -o /etc/apt/keyrings/docker.gpg /tmp/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$DOCKER_DISTRO $DOCKER_CODENAME stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Log in again, then verify:

```bash
docker version
docker compose version
docker run --rm hello-world
```

Do not replace an existing engine on a host with important containers. Use a
dedicated ECS instance for this POC.

### Deploy

```bash
git clone https://github.com/your-org/volc-agent-launchpad.git
cd volc-agent-launchpad
cp .env.example .env.production
openssl rand -hex 32
```

Set these values in `.env.production`:

```dotenv
PUBLIC_PORT=80
ARK_API_KEY=your-ark-api-key
ARK_MODEL=ep-your-endpoint-id
APP_AUTH_TOKEN=the-random-token-generated-above
```

Deploy:

```bash
chmod 600 .env.production
./scripts/deploy-existing-ecs.sh .env.production
```

Verify:

```bash
curl http://127.0.0.1/api/health
export APP_AUTH_TOKEN=your-shared-demo-token
curl -H "Authorization: Bearer $APP_AUTH_TOKEN" \
  http://127.0.0.1/api/system
docker compose --env-file .env.production ps
```

Deploy updates with `git pull --ff-only`, then rerun the deployment script.

### Network and cleanup

- Allow TCP 80 only from the event network.
- Allow TCP 22 only from administrator IP addresses.
- Allow outbound HTTPS to Ark and package registries.
- Add HTTPS before using `APP_AUTH_TOKEN` across an untrusted network.

Stop the application without deleting Agent data:

```bash
docker compose --env-file .env.production down
```

## Terraform deployment

Terraform uses `volcenginecc` to create a VPC, subnet, security group, ECS
instance, EIP, and cloud-init configuration.

Requirements:

- Terraform 1.6+
- Volcengine account AK/SK with resource-creation permissions
- Existing ECS SSH key pair
- Ubuntu image ID and instance type available in the selected region
- Public Git URL for this repository

Create configuration files:

```bash
cp .env.example .env.production
cp deploy/volcengine/terraform.tfvars.example \
  deploy/volcengine/terraform.tfvars
```

Set `ARK_API_KEY` and `ARK_MODEL` in `.env.production`. Set the region, zone,
image, instance type, key pair, allowed CIDRs, and repository URL in
`terraform.tfvars`.

Provide account credentials only through the current shell:

```bash
export VOLCENGINE_ACCESS_KEY=your-access-key
export VOLCENGINE_SECRET_KEY=your-secret-key
./scripts/deploy-volcengine.sh
```

After Terraform prints `app_url`, allow 5 to 10 minutes for cloud-init and the
Docker build. Inspect progress with:

```bash
ssh root@your-ecs-public-ip
cloud-init status --wait
tail -n 200 /var/log/cloud-init-output.log
```

Destroy the stack when the event ends:

```bash
terraform -chdir=deploy/volcengine destroy
```

> [!CAUTION]
> Destroying the stack removes the ECS instance, system disk, and Agent
> workspaces. Back up required code first.

## Secret handling

- Ark keys configure model access; Volcengine account AK/SK configures
  Terraform. Never pass account AK/SK to an Agent Runtime.
- `.env.production`, `terraform.tfvars`, and Terraform state must not be
  committed.
- The POC stores the Ark key in Terraform user data and state. Production
  deployments require managed secrets and an encrypted remote state backend.
