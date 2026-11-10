# SPECTRE — dedicate the Windows "Ethernet" NIC to the turntable.
# - Wi-Fi keeps internet (default route unchanged)
# - Tailscale keeps VPN
# - Ethernet gets 10.55.55.1/24 (avoids Tailscale's 192.168.1.0/24 route)
# Also adds 192.168.1.100 alias + /32 host routes for factory-default PTZ IPs.
#
# Run elevated once after plugging the RJ45 into the turntable BOTTOM network port:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-ethernet-ptz.ps1

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$alias = 'Ethernet'

Write-Host "==> SPECTRE Ethernet PTZ link on '$alias'"
$nic = Get-NetAdapter -Name $alias -ErrorAction Stop
if ($nic.Status -ne 'Up') {
  Write-Warning "Adapter '$alias' is $($nic.Status). Plug the cable / power the turntable (DC24V)."
}

# Primary isolated subnet for DHCP-less / DHCP-offered heads
netsh interface ip set address name="$alias" static 10.55.55.1 255.255.255.0 | Out-Null
Start-Sleep -Seconds 1
# Secondary alias for common Chinese factory defaults on 192.168.1.x
netsh interface ip add address name="$alias" addr=192.168.1.100 mask=255.255.255.0 2>$null | Out-Null

$ifIndex = (Get-NetAdapter -Name $alias).ifIndex
foreach ($ip in @(
  '192.168.1.64','192.168.1.168','192.168.1.10','192.168.1.108',
  '192.168.1.200','192.168.1.88','192.168.0.64','192.168.0.168'
)) {
  try {
    New-NetRoute -DestinationPrefix "$ip/32" -InterfaceIndex $ifIndex -NextHop '0.0.0.0' -RouteMetric 1 -ErrorAction Stop | Out-Null
  } catch {
    # already exists
  }
}

Write-Host 'Ethernet IPv4:'
Get-NetIPAddress -InterfaceAlias $alias -AddressFamily IPv4 | Format-Table IPAddress, PrefixLength -AutoSize
Write-Host 'Default route (must stay Wi-Fi):'
Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Format-Table InterfaceAlias, NextHop, RouteMetric -AutoSize
Write-Host ''
Write-Host 'Next: power the turntable, then run:'
Write-Host '  node scripts\ethernet-dhcp-and-discover.mjs'
Write-Host 'When an IP/port is found, SPECTRE will use udp://IP:PORT (default udp://10.55.55.50:6666).'
