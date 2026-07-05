#!/usr/bin/env bash
set -euo pipefail

sudo helm repo add bitnami https://charts.bitnami.com/bitnami
sudo helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
sudo helm repo add jetstack https://charts.jetstack.io
sudo helm repo add mailu https://mailu.github.io/helm-charts/
sudo helm repo add metallb https://metallb.github.io/metallb
