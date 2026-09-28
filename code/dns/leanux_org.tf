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
