# leanux.org — the OS project's domain (phonos, to be renamed Leanux).
#
# Sends no mail, and says so: without these anyone can spoof the domain.

resource "cloudflare_dns_record" "leanux_spf" {
  zone_id = cloudflare_zone.leanux_org.id
  type    = "TXT"
  name    = "leanux.org"
  content = "v=spf1 -all"
  ttl     = 3600
}

resource "cloudflare_dns_record" "leanux_dmarc" {
  zone_id = cloudflare_zone.leanux_org.id
  type    = "TXT"
  name    = "_dmarc.leanux.org"
  content = "v=DMARC1; p=reject; adkim=s; aspf=s"
  ttl     = 3600
}

# The site, on isis's host nginx front door (kubes dhall/sites/leanux.dhall).
# Grey-cloud like every other isis name: the front door holds the certificate.
# A CNAME at the apex is flattened by Cloudflare.

resource "cloudflare_dns_record" "leanux_apex" {
  zone_id = cloudflare_zone.leanux_org.id
  type    = "CNAME"
  name    = "leanux.org"
  content = "isis.xinutec.org"
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "leanux_www" {
  zone_id = cloudflare_zone.leanux_org.id
  type    = "CNAME"
  name    = "www.leanux.org"
  content = "isis.xinutec.org"
  ttl     = 3600
  proxied = false
}
