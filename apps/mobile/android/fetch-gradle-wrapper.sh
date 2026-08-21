#!/bin/sh
set -e
cd "$(dirname "$0")"
mkdir -p gradle/wrapper
curl -fSL -o gradle/wrapper/gradle-wrapper.jar \
  https://raw.githubusercontent.com/gradle/gradle/v8.11.1/gradle/wrapper/gradle-wrapper.jar
echo "Saved gradle/wrapper/gradle-wrapper.jar"
