# homectl.org — GitHub Pages

resource "cloudflare_dns_record" "homectl_apex_1" {
  zone_id = cloudflare_zone.homectl_org.id
  type    = "A"
  name    = "homectl.org"
  content = "185.199.108.153"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "homectl_apex_2" {
  zone_id = cloudflare_zone.homectl_org.id
  type    = "A"
  name    = "homectl.org"
  content = "185.199.109.153"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "homectl_apex_3" {
  zone_id = cloudflare_zone.homectl_org.id
  type    = "A"
  name    = "homectl.org"
  content = "185.199.110.153"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "homectl_apex_4" {
  zone_id = cloudflare_zone.homectl_org.id
  type    = "A"
  name    = "homectl.org"
  content = "185.199.111.153"
  ttl     = 3600
  proxied = false
}
