# xinutec.de — wildcard CNAME to xinutec.org

resource "cloudflare_dns_record" "de_apex" {
  zone_id = cloudflare_zone.xinutec_de.id
  type    = "CNAME"
  name    = "xinutec.de"
  content = "xinutec.org"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "de_wildcard" {
  zone_id = cloudflare_zone.xinutec_de.id
  type    = "CNAME"
  name    = "*"
  content = "xinutec.org"
  ttl     = 3600
  proxied = false
}
