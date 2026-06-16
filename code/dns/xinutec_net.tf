locals {
  xinutec_net_id = cloudflare_zone.xinutec_net.id
}

# --- A records (GitHub Pages) ---

resource "cloudflare_dns_record" "net_apex_1" {
  zone_id = local.xinutec_net_id
  type    = "A"
  name    = "xinutec.net"
  content = "185.199.108.153"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "net_apex_2" {
  zone_id = local.xinutec_net_id
  type    = "A"
  name    = "xinutec.net"
  content = "185.199.109.153"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "net_apex_3" {
  zone_id = local.xinutec_net_id
  type    = "A"
  name    = "xinutec.net"
  content = "185.199.110.153"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "net_apex_4" {
  zone_id = local.xinutec_net_id
  type    = "A"
  name    = "xinutec.net"
  content = "185.199.111.153"
  ttl     = 3600
  proxied = false
}

# --- CNAME ---

resource "cloudflare_dns_record" "net_www" {
  zone_id = local.xinutec_net_id
  type    = "CNAME"
  name    = "www"
  content = "xinutec.net"
  ttl     = 3600
  proxied = false
}

# --- AAAA (IRC on isis) ---

resource "cloudflare_dns_record" "net_irc_v6" {
  zone_id = local.xinutec_net_id
  type    = "AAAA"
  name    = "irc"
  content = "2a01:4f8:190:50d1::6697"
  ttl     = 600
  proxied = false
}

# --- A (IRC) ---

resource "cloudflare_dns_record" "net_irc_v4_isis" {
  zone_id = local.xinutec_net_id
  type    = "A"
  name    = "irc"
  content = "188.165.200.180"
  ttl     = 600
  proxied = false
}

resource "cloudflare_dns_record" "net_irc_v4_legacy" {
  zone_id = local.xinutec_net_id
  type    = "A"
  name    = "irc"
  content = "5.9.157.210"
  ttl     = 600
  proxied = false
}

# --- A (webchat → partner-operated IRC host 5.9.157.210, outside our fleet) ---

resource "cloudflare_dns_record" "net_webchat_v4" {
  zone_id = local.xinutec_net_id
  type    = "A"
  name    = "webchat"
  content = "5.9.157.210"
  ttl     = 600
  proxied = false
}

# --- Wildcard MX (all subdomains deliver to mail.xinutec.org) ---

resource "cloudflare_dns_record" "net_wildcard_mx" {
  zone_id  = local.xinutec_net_id
  type     = "MX"
  name     = "*"
  content  = "mail.xinutec.org"
  priority = 10
  ttl      = 3600
}
