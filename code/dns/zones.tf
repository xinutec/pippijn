resource "cloudflare_zone" "xinutec_org" {
  account = {
    id = var.cloudflare_account_id
  }
  name = "xinutec.org"
}

resource "cloudflare_zone" "xinutec_net" {
  account = {
    id = var.cloudflare_account_id
  }
  name = "xinutec.net"
}

resource "cloudflare_zone" "homectl_org" {
  account = {
    id = var.cloudflare_account_id
  }
  name = "homectl.org"
}

resource "cloudflare_zone" "xinutec_com" {
  account = {
    id = var.cloudflare_account_id
  }
  name = "xinutec.com"
}

resource "cloudflare_zone" "xinutec_de" {
  account = {
    id = var.cloudflare_account_id
  }
  name = "xinutec.de"
}
