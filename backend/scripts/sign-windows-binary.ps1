param(
	[Parameter(Mandatory = $true)][string]$Path,
	[Parameter(Mandatory = $true)][string]$Thumbprint
)

$ErrorActionPreference = 'Stop'
$normalized = $Thumbprint.Replace(' ', '').ToUpperInvariant()
$certificate = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My |
	Where-Object { $_.Thumbprint -eq $normalized -and $_.HasPrivateKey -and $_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3' } |
	Select-Object -First 1
if (-not $certificate) { throw "Code-signing certificate was not found: $normalized" }
$signature = Set-AuthenticodeSignature -LiteralPath $Path -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
if ($signature.Status -ne 'Valid') { throw "Authenticode signing failed: $($signature.StatusMessage)" }
