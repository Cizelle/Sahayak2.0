# One-time: fetches gradle-wrapper.jar (the single binary not shipped in the repo).
# Run from apps/mobile/android:   powershell -ExecutionPolicy Bypass -File .\fetch-gradle-wrapper.ps1
$ErrorActionPreference = "Stop"
$dir = Join-Path $PSScriptRoot "gradle\wrapper"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$jar = Join-Path $dir "gradle-wrapper.jar"
$url = "https://raw.githubusercontent.com/gradle/gradle/v8.11.1/gradle/wrapper/gradle-wrapper.jar"
Write-Host "Downloading gradle-wrapper.jar from $url"
Invoke-WebRequest -Uri $url -OutFile $jar
Write-Host "Saved $jar"
