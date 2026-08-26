terraform {
  required_version = ">= 1.6.0"

  required_providers {
    volcenginecc = {
      source  = "volcengine/volcenginecc"
      version = "0.0.58"
    }
  }
}

provider "volcenginecc" {
  region = var.region
}
