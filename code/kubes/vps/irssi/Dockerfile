FROM ubuntu:22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
 ca-certificates \
 irssi \
 libauthen-sasl-perl \
 libcommon-sense-perl \
 locales \
 netcat \
 openssh-server \
 rsync \
 screen \
 vim \
 && apt-get clean

RUN groupadd -r -g 1000 irssi \
 && useradd -m --no-log-init -r -g irssi -u 1000 -s /bin/bash irssi \
 && locale-gen en_US.UTF-8 \
 && update-locale LANG=en_US.UTF-8

WORKDIR /home/irssi
COPY init.sh /
COPY etc /etc/
COPY home /home/
RUN chmod 644 /etc/screenrc \
 && mkdir /etc/ssh_keys
ENTRYPOINT ["/init.sh"]
