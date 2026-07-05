#!/usr/bin/env bash

set -euo pipefail

USER=pippijn
PASS=$1

#curl -u "$USER:$PASS" --insecure -i -X PROPFIND "https://dash.xinutec.org/remote.php/dav/addressbooks/users/$USER/contacts/" --upload-file - -H "Depth: 1" <<end
#<?xml version="1.0"?>
#<a:propfind xmlns:a="DAV:">
#<a:prop><a:resourcetype/></a:prop>
#</a:propfind>
#end

curl -u "$USER:$PASS" -v http://nextcloud-server.nextcloud.svc.cluster.local/remote.php/dav/addressbooks/users/pippijn/contacts/824408F2-44AB-4900-AC6F-F229B53D5C83.vcf
