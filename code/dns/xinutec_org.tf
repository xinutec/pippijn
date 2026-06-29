locals {
  xinutec_org_id = cloudflare_zone.xinutec_org.id

  hosts = {
    amun     = "94.23.247.133"
    isis     = "188.165.200.180"
    odin     = "5.196.65.240"
    vpn      = "10.100.0.1"   # amun WireGuard LB IP — VPN-only services (vault)
    vpn_isis = "10.100.0.2"   # isis WireGuard LB IP — VPN-only services (messages)
  }
}

# --- Host A records ---

# vault.xinutec.org — Vaultwarden password manager, VPN-only.
# Points at the WireGuard LB IP, so it resolves publicly but only routes over the VPN.
resource "cloudflare_dns_record" "org_vault" {
  zone_id = local.xinutec_org_id
  type    = "A"
  name    = "vault"
  content = local.hosts.vpn
  ttl     = 3600
  proxied = false
}

# messages.xinutec.org — Signal + Google Chat archive viewer on isis, VPN-only.
# Resolves to isis's WireGuard IP so it's unlisted publicly; the real gate is the
# Nextcloud login + pippijn-only allow-list (the isis ingress also answers on the
# public IP). See code/kubes/messages.
resource "cloudflare_dns_record" "org_messages" {
  zone_id = local.xinutec_org_id
  type    = "A"
  name    = "messages"
  content = local.hosts.vpn_isis
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "org_apex" {
  zone_id = local.xinutec_org_id
  type    = "A"
  name    = "xinutec.org"
  content = local.hosts.amun
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "org_amun" {
  zone_id = local.xinutec_org_id
  type    = "A"
  name    = "amun"
  content = local.hosts.amun
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "org_isis" {
  zone_id = local.xinutec_org_id
  type    = "A"
  name    = "isis"
  content = local.hosts.isis
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "org_odin" {
  zone_id = local.xinutec_org_id
  type    = "A"
  name    = "odin"
  content = local.hosts.odin
  ttl     = 3600
  proxied = false
}

# --- CNAMEs ---

resource "cloudflare_dns_record" "org_mail" {
  zone_id = local.xinutec_org_id
  type    = "CNAME"
  name    = "mail"
  content = "amun.xinutec.org"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "org_dash" {
  zone_id = local.xinutec_org_id
  type    = "CNAME"
  name    = "dash"
  content = "isis.xinutec.org"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "org_irc" {
  zone_id = local.xinutec_org_id
  type    = "CNAME"
  name    = "irc"
  content = "irc.xinutec.net"
  ttl     = 3600
  proxied = false
}

# --- MX ---

resource "cloudflare_dns_record" "org_mx" {
  zone_id  = local.xinutec_org_id
  type     = "MX"
  name     = "xinutec.org"
  content  = "mail.xinutec.org"
  priority = 10
  ttl      = 3600
}

# --- TXT (SPF, DMARC, DKIM, site verification) ---

resource "cloudflare_dns_record" "org_spf" {
  zone_id = local.xinutec_org_id
  type    = "TXT"
  name    = "xinutec.org"
  content = "v=spf1 mx a:mail.xinutec.org ip4:94.23.247.133 ~all"
  ttl     = 600
}

resource "cloudflare_dns_record" "org_google_verify" {
  zone_id = local.xinutec_org_id
  type    = "TXT"
  name    = "xinutec.org"
  content = "google-site-verification=JrY6mtwaCKsVi-2XnAFgBJ0albfgmkpPIbeMpBsgUPU"
  ttl     = 600
}

resource "cloudflare_dns_record" "org_dmarc" {
  zone_id = local.xinutec_org_id
  type    = "TXT"
  name    = "_dmarc"
  content = "v=DMARC1; p=reject; adkim=s; aspf=s"
  ttl     = 600
}

resource "cloudflare_dns_record" "org_dkim" {
  zone_id = local.xinutec_org_id
  type    = "TXT"
  name    = "dkim._domainkey"
  content = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqzkg187Oq5SnWZWD/zq+m0SsVjkeWpELaxIA4FO6zm+EVD9p8sxzV0AfbQh65DiqwmCv2vAA40I5KlhskOTlLgZkWicgyQNi9Z+tczLB+UH/8eYdFWHgpHXKVB0EBuQcAl4j69JXvOT+HnRtDoDTJZo7sayfjx+OCUymvuk0EnU7gamyMLPcnkBrVFaD5Dj/zGCJbYL0/5rfVb8XKf44W8lCcM1suMyI3PIFKcaGaKNTdaPNNuZP+bG0rFjgZQJcyhObYxf29UqDq4KUAn+pn3rPcVNa6Apo66EitIPKHXTholfh7ycb1CmniD1gImJd/9fsMyRgkW0o1FITzP0e9QIDAQAB"
  ttl     = 600
}

# --- Health data service (Fitbit sync) ---

resource "cloudflare_dns_record" "org_health" {
  zone_id = local.xinutec_org_id
  type    = "CNAME"
  name    = "health"
  content = "isis.xinutec.org"
  ttl     = 3600
  proxied = false
}

# --- Home environment dashboard (IQAir AirVisual Pro) ---

resource "cloudflare_dns_record" "org_home" {
  zone_id = local.xinutec_org_id
  type    = "CNAME"
  name    = "home"
  content = "isis.xinutec.org"
  ttl     = 3600
  proxied = false
}

# --- Personal "life" app (home inventory, recipes, 3D house) ---

resource "cloudflare_dns_record" "org_life" {
  zone_id = local.xinutec_org_id
  type    = "CNAME"
  name    = "life"
  content = "isis.xinutec.org"
  ttl     = 3600
  proxied = false
}
