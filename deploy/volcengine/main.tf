locals {
  name = "agent-launchpad"

  ingress_permissions = [
    {
      description     = "Agent Launchpad web"
      direction       = "ingress"
      policy          = "accept"
      port_end        = 80
      port_start      = 80
      priority        = 1
      protocol        = "tcp"
      cidr_ip         = var.allowed_web_cidr
      prefix_list_id  = ""
      source_group_id = ""
    },
    {
      description     = "Agent Launchpad SSH"
      direction       = "ingress"
      policy          = "accept"
      port_end        = 22
      port_start      = 22
      priority        = 1
      protocol        = "tcp"
      cidr_ip         = var.allowed_ssh_cidr
      prefix_list_id  = ""
      source_group_id = ""
    }
  ]

  runtime_env = join("\n", [
    "NODE_ENV=production",
    "HOST=0.0.0.0",
    "PORT=3000",
    "PUBLIC_PORT=80",
    "LOG_LEVEL=info",
    "APP_AUTH_TOKEN=${var.app_auth_token}",
    "ARK_API_KEY=${var.ark_api_key}",
    "ARK_MODEL=${var.ark_model}",
    "ARK_BASE_URL=${var.ark_base_url}",
    "APP_DATA_DIR=/app/data",
    "AGENT_WORKSPACE_ROOT=/app/workspaces",
    "CODEX_HOME=/app/codex-home",
    "CODEX_BIN=codex",
    "CODEX_SANDBOX_MODE=workspace-write",
    "CODEX_TIMEOUT_MS=600000",
    "CODEX_MAX_OUTPUT_BYTES=2097152",
    ""
  ])
}

resource "volcenginecc_vpc_vpc" "launchpad" {
  vpc_name              = local.name
  description           = "VPC for the CodeJam Agent Launchpad starter kit"
  cidr_block            = "172.20.0.0/16"
  support_ipv_4_gateway = true
  enable_ipv_6          = false
  project_name          = var.project_name
  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}

resource "volcenginecc_vpc_subnet" "launchpad" {
  vpc_id      = volcenginecc_vpc_vpc.launchpad.id
  zone_id     = var.zone_id
  subnet_name = local.name
  description = "Agent Launchpad subnet"
  cidr_block  = "172.20.1.0/24"
  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}

resource "volcenginecc_vpc_security_group" "launchpad" {
  vpc_id              = volcenginecc_vpc_vpc.launchpad.id
  security_group_name = local.name
  description         = "Web and SSH access for Agent Launchpad"
  project_name        = var.project_name
  ingress_permissions = local.ingress_permissions
  egress_permissions = [
    {
      description     = "Outbound access for Ark, Git and package registries"
      direction       = "egress"
      policy          = "accept"
      port_end        = -1
      port_start      = -1
      priority        = 1
      protocol        = "all"
      cidr_ip         = "0.0.0.0/0"
      prefix_list_id  = ""
      source_group_id = ""
    }
  ]
  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}

resource "volcenginecc_ecs_instance" "launchpad" {
  instance_name        = local.name
  hostname             = "agent-launchpad"
  description          = "CodeJam Agent Launchpad starter kit"
  project_name         = var.project_name
  instance_charge_type = "PostPaid"
  instance_type        = var.instance_type
  spot_strategy        = "NoSpot"
  deletion_protection  = false
  zone_id              = var.zone_id

  image = {
    image_id                      = var.image_id
    keep_image_credential         = false
    security_enhancement_strategy = "Active"
  }

  key_pair = {
    key_pair_name = var.key_pair_name
  }

  primary_network_interface = {
    security_group_ids = [volcenginecc_vpc_security_group.launchpad.id]
    subnet_id          = volcenginecc_vpc_subnet.launchpad.id
    vpc_id             = volcenginecc_vpc_vpc.launchpad.id
  }

  system_volume = {
    size                 = 50
    delete_with_instance = true
    volume_type          = "ESSD_PL0"
  }

  eip_address = {
    charge_type           = "PayByTraffic"
    bandwidth_mbps        = 5
    isp                   = "BGP"
    release_with_instance = true
    bandwidth_package_id  = ""
  }

  user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
    repository_url  = var.repository_url
    repository_ref  = var.repository_ref
    runtime_env_b64 = base64encode(local.runtime_env)
  }))

  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}
