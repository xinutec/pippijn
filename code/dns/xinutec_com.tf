# xinutec.com — wildcard CNAME to xinutec.org

resource "cloudflare_dns_record" "com_apex" {
  zone_id = cloudflare_zone.xinutec_com.id
  type    = "CNAME"
  name    = "xinutec.com"
  content = "xinutec.org"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "com_wildcard" {
  zone_id = cloudflare_zone.xinutec_com.id
  type    = "CNAME"
  name    = "*"
  content = "xinutec.org"
  ttl     = 3600
  proxied = false
}
