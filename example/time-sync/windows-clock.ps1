param(
    [ValidateRange(-315360000000, 315360000000)][double]$OffsetMs = 0,
    [switch]$Apply,
    [switch]$CheckOnly,
    [long]$BaselineUtcTicks = 0,
    [long]$BaselineCounter = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# UTC and a monotonic counter are carried through UAC. The elapsed time is
# included at the instant of setting the clock, rather than setting an old date.
function Initialize-ClockApi {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ToolboxClock {
    [StructLayout(LayoutKind.Sequential)]
    public struct SYSTEMTIME {
        public ushort Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetSystemTime(ref SYSTEMTIME time);
    public static bool SetUtc(DateTime utc) {
        var time = new SYSTEMTIME {
            Year = (ushort)utc.Year, Month = (ushort)utc.Month,
            Day = (ushort)utc.Day, Hour = (ushort)utc.Hour,
            Minute = (ushort)utc.Minute, Second = (ushort)utc.Second,
            Milliseconds = (ushort)utc.Millisecond
        };
        return SetSystemTime(ref time);
    }
}
'@
}

function Invoke-Calibration {
    Initialize-ClockApi
    $elapsedMs = ([Diagnostics.Stopwatch]::GetTimestamp() - $BaselineCounter) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
    if ($elapsedMs -lt 0 -or $elapsedMs -gt 90000) { return 14 }
    $expectedUtc = [DateTime]::new($BaselineUtcTicks, [DateTimeKind]::Utc).AddMilliseconds($elapsedMs)
    if ([Math]::Abs(([DateTime]::UtcNow - $expectedUtc).TotalMilliseconds) -gt 200) { return 15 }
    # Compile the interop code before taking the final current-time reading.
    $targetUtc = [DateTime]::UtcNow.AddMilliseconds($OffsetMs)
    if (-not [ToolboxClock]::SetUtc($targetUtc)) {
        $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($nativeError -eq 5 -or $nativeError -eq 1314) { return 5 }
        return 13
    }
    return 0
}

try {
    if ($CheckOnly) {
        Initialize-ClockApi
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        @{ ok = $true; checkOnly = $true; administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); utc = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
        exit 0
    }
    if ($Apply) { exit (Invoke-Calibration) }

    $BaselineUtcTicks = [DateTime]::UtcNow.Ticks
    $BaselineCounter = [Diagnostics.Stopwatch]::GetTimestamp()
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        $resultCode = Invoke-Calibration
    } else {
        $offsetText = $OffsetMs.ToString('R', [Globalization.CultureInfo]::InvariantCulture)
        $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Apply -OffsetMs {1} -BaselineUtcTicks {2} -BaselineCounter {3}' -f $PSCommandPath, $offsetText, $BaselineUtcTicks, $BaselineCounter
        $child = Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
        $resultCode = $child.ExitCode
    }
    @{ ok = ($resultCode -eq 0); code = $resultCode } | ConvertTo-Json -Compress
} catch {
    $cancelled = $_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.InnerException.NativeErrorCode -eq 1223
    @{ ok = $false; code = $(if ($cancelled) { 1223 } else { 13 }); message = $_.Exception.Message } | ConvertTo-Json -Compress
}
