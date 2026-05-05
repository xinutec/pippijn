# xinutec.com — redirects everything to xinutec.org

resource "cloudflare_dns_record" "com_apex" {
  zone_id = cloudflare_zone.xinutec_com.id
  type    = "CNAME"
  name    = "xinutec.com"
  content = "xinutec.org"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "com_www" {
  zone_id = cloudflare_zone.xinutec_com.id
  type    = "CNAME"
  name    = "www"
  content = "xinutec.org"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "com_mail" {
  zone_id = cloudflare_zone.xinutec_com.id
  type    = "CNAME"
  name    = "mail"
  content = "xinutec.org"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "com_dmarc" {
  zone_id = cloudflare_zone.xinutec_com.id
  type    = "CNAME"
  name    = "_dmarc"
  content = "xinutec.org"
  ttl     = 3600
  proxied = false
}
