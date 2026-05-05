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
