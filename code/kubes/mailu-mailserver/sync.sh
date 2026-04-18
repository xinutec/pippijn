#!/bin/sh

sudo helm upgrade --install mailu mailu/mailu --version 2.1.1 -n mailu-mailserver --create-namespace --values values.yaml --values secrets.yaml
