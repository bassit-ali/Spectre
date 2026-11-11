$ErrorActionPreference = 'Continue'
$log = 'C:\Users\aXe\AppData\Local\Temp\spectre-eth-scan.log'
function L($m) { Add-Content -Path $log -Value $m }

Remove-Item $log -ErrorAction SilentlyContinue
L "start $(Get-Date -Format o)"
L "Ethernet IPs:"
Get-NetIPAddress -InterfaceAlias Ethernet -AddressFamily IPv4 | ForEach-Object { L ("  {0}/{1}" -f $_.IPAddress, $_.PrefixLength) }

# Factory-default subnet alias (many Chinese PTZ use 192.168.1.x)
netsh interface ip add address name="Ethernet" addr=192.168.1.100 mask=255.255.255.0 | ForEach-Object { L $_ }
Start-Sleep -Seconds 1
$ifIndex = (Get-NetAdapter -Name Ethernet).ifIndex
L "Ethernet ifIndex=$ifIndex"
foreach ($ip in @('192.168.1.64','192.168.1.168','192.168.1.10','192.168.1.108','192.168.1.200','192.168.1.88','192.168.0.64','192.168.0.168')) {
  try {
    New-NetRoute -DestinationPrefix "$ip/32" -InterfaceIndex $ifIndex -NextHop '0.0.0.0' -RouteMetric 1 -ErrorAction Stop | Out-Null
    L "route $ip/32 via Ethernet ok"
  } catch {
    L "route $ip/32: $($_.Exception.Message)"
  }
}

$targets = New-Object System.Collections.Generic.List[string]
1..254 | ForEach-Object { [void]$targets.Add("10.55.55.$_") }
foreach ($ip in @('192.168.1.64','192.168.1.168','192.168.1.10','192.168.1.108','192.168.1.200','192.168.1.88','192.168.0.64','192.168.0.168','192.168.1.1','192.168.1.2')) {
  [void]$targets.Add($ip)
}
L "pinging $($targets.Count) targets"
$alive = [System.Collections.Concurrent.ConcurrentBag]::new()
$targets | ForEach-Object -Parallel {
  if (Test-Connection -ComputerName $_ -Count 1 -Quiet -TimeoutSeconds 1) {
    ($using:alive).Add($_) | Out-Null
  }
} -ThrottleLimit 64
L 'ALIVE:'
foreach ($a in $alive) { L "  $a" }

L 'ARP neighbors:'
Get-NetNeighbor -InterfaceAlias Ethernet -AddressFamily IPv4 |
  Where-Object { $_.State -ne 'Unreachable' -and $_.IPAddress -notmatch '^(224\.|255\.|239\.)' } |
  ForEach-Object { L ("  {0}  {1}  {2}" -f $_.IPAddress, $_.LinkLayerAddress, $_.State) }

L "done $(Get-Date -Format o)"
