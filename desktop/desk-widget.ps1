# 飞书任务便签 · 桌面插件（WPF 无边框 + DWM Acrylic 真毛玻璃）
#   双击 desktop\start-widget.vbs 启动；右键窗口可切换置顶 / 磨砂 / 刷新 / 开机自启 / 退出
param(
  [string]$RenderTo = '',   # 把窗口内容渲染成 PNG（无桌面环境也能取证）
  [switch]$SelfTest,        # 程序化点一次圆点，验证点击链路
  [switch]$NoGlass,         # 关掉 DWM 毛玻璃（万一某些机器上磨砂把窗口吃成透明）
  [switch]$StartCollapsed,  # 自检用：以收起状态渲染 / 启动
  [int]$StartOpacity = -1   # 自检用：以指定透明度（0-100）渲染 / 启动
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, UIAutomationTypes, UIAutomationProvider

$here    = Split-Path -Parent $MyInvocation.MyCommand.Path   # desktop/
$pkgRoot = Split-Path -Parent $here                                   # 仓库根（含 package.json）
if (-not $env:FEISHU_TASK_DATA) {
  $marker = Join-Path $pkgRoot '.data-dir'
  if (Test-Path $marker) {
    $env:FEISHU_TASK_DATA = (Get-Content -Raw -LiteralPath $marker).Trim()
  } else {
    $env:FEISHU_TASK_DATA = Join-Path $env:USERPROFILE '.feishu-task-widget'   # 与 src/lib/config.mjs 保持一致
  }
}
$dataDir = $env:FEISHU_TASK_DATA
$stateD  = Join-Path $dataDir 'state'
if (-not (Test-Path $stateD)) { New-Item -ItemType Directory -Path $stateD -Force | Out-Null }

$logFile = Join-Path $stateD 'widget.log'
function Write-Log([string]$msg) {
  try { Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $msg) -Encoding UTF8 } catch { }
}
Write-Log ('启动 pid=' + $PID + ' 参数=' + ($args -join ' '))
$pidFile = Join-Path $stateD 'widget.pid'
$node    = (Get-Command node -ErrorAction Stop).Source
$setCli  = Join-Path $pkgRoot 'src\set.mjs'
$stateFile = Join-Path $stateD 'widget-state.json'
$posFile   = Join-Path $stateD 'widget-pos.json'
$launcher  = Join-Path $here 'start-widget.cmd'

$w32 = @'
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void Dpi() { try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { SetProcessDPIAware(); } }

  [StructLayout(LayoutKind.Sequential)] public struct Accent { public int AccentState; public int AccentFlags; public int GradientColor; public int AnimationId; }
  [StructLayout(LayoutKind.Sequential)] public struct Data { public IntPtr Attribute; public IntPtr DataPtr; public int SizeOfData; }
  [DllImport("user32.dll")] public static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref Data data);
  public static int Glass(IntPtr hwnd, int state, int tint) {
    Accent accent = new Accent();
    accent.AccentState = state; accent.AccentFlags = 2; accent.GradientColor = tint; accent.AnimationId = 0;
    int size = Marshal.SizeOf(accent);
    IntPtr p = Marshal.AllocHGlobal(size);
    Marshal.StructureToPtr(accent, p, false);
    Data d = new Data(); d.Attribute = new IntPtr(19); d.DataPtr = p; d.SizeOfData = size;
    int r = SetWindowCompositionAttribute(hwnd, ref d);
    Marshal.FreeHGlobal(p);
    return r;
  }
}
'@
Add-Type -TypeDefinition $w32 -Language CSharp
[W32]::Dpi()

# 单实例
$testMode = [bool]($RenderTo -or $SelfTest -or $StartCollapsed -or ($StartOpacity -ge 0))
$script:hwnd = [IntPtr]::Zero
$script:glassOn = -not $NoGlass

$mutex = New-Object System.Threading.Mutex($false, 'FeishuTaskWidget_single')
if ($testMode) {
  Write-Log '自检模式：跳过单实例检查'
} elseif ($mutex.WaitOne(0)) {
  try { Set-Content -LiteralPath $pidFile -Value $PID -Encoding ASCII } catch { }
} else {
  Write-Log '已有实例在运行：尝试把已有窗口拉到最前，然后退出'
  try {
    $hWnd = (New-Object System.Diagnostics.Process[] 0) # 占位，见下方真实查找
    Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class Raiser {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  public static bool Raise(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512);
      if (sb.ToString() == title && IsWindowVisible(h)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    SetWindowPos(found, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    SetForegroundWindow(found);
    return true;
  }
}
'@ -Language CSharp -ErrorAction SilentlyContinue
    $raised = [Raiser]::Raise('飞书任务便签')
    Write-Log ('已有窗口置前结果=' + $raised)
  } catch {
    Write-Log ('置前失败：' + ($_ | Out-String))
  }
  exit 0
}

$ink   = '#FF262D3D'; $ink2 = '#FF59627A'; $ink3 = '#FF8B93A6'
$hot   = '#FFE2557B'; $accent = '#FF5B8DEF'; $ok = '#FF2FAE7E'

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="飞书任务便签" Width="424" Height="800" MinWidth="340" MinHeight="260"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ResizeMode="NoResize" ShowInTaskbar="False" Topmost="True"
        WindowStartupLocation="Manual" UseLayoutRounding="True"
        FontFamily="Microsoft YaHei UI" TextOptions.TextFormattingMode="Ideal">
  <Window.Resources>
    <Style x:Key="Chip" TargetType="Button">
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Foreground" Value="#FF59627A"/>
      <Setter Property="Margin" Value="5,0,0,0"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" CornerRadius="9" Background="#3DFFFFFF" BorderBrush="#66FFFFFF" BorderThickness="1" Padding="10,4">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="bd" Property="Background" Value="#A6FFFFFF"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="ChipOn" TargetType="Button" BasedOn="{StaticResource Chip}">
      <Setter Property="Foreground" Value="#FF262D3D"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" CornerRadius="9" Background="#F2FFFFFF" BorderBrush="#CCFFFFFF" BorderThickness="1" Padding="10,4">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Nav" TargetType="Button" BasedOn="{StaticResource Chip}">
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="Padding" Value="7,0"/>
      <Setter Property="Foreground" Value="#FF59627A"/>
    </Style>
    <Style x:Key="Tick" TargetType="Button">
      <Setter Property="Width" Value="19"/><Setter Property="Height" Value="19"/>
      <Setter Property="Cursor" Value="Hand"/><Setter Property="VerticalAlignment" Value="Top"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Grid>
              <Ellipse x:Name="ring" Stroke="#FF97A3BC" StrokeThickness="1.4" Fill="#33FFFFFF"/>
              <Path x:Name="check" Data="M 0,3.2 L 3.1,6.3 L 8,0.9" Stroke="White" StrokeThickness="1.8"
                    StrokeStartLineCap="Round" StrokeEndLineCap="Round" Visibility="Collapsed"
                    HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="ring" Property="Stroke" Value="#FF5B8DEF"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="TickDone" TargetType="Button" BasedOn="{StaticResource Tick}">
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Grid>
              <Ellipse Stroke="#FF2FAE7E" Fill="#FF2FAE7E" StrokeThickness="1.4"/>
              <Path Data="M 0,3.2 L 3.1,6.3 L 8,0.9" Stroke="White" StrokeThickness="1.8"
                    StrokeStartLineCap="Round" StrokeEndLineCap="Round"
                    HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Cell" TargetType="Button">
      <Setter Property="Margin" Value="1.5"/>
      <Setter Property="Height" Value="44"/>
      <Setter Property="Padding" Value="0"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Background" Value="#26FFFFFF"/>
      <Setter Property="BorderBrush" Value="#4DFFFFFF"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" CornerRadius="11" Background="{TemplateBinding Background}"
                    BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1" Padding="5,4">
              <ContentPresenter/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="bd" Property="Background" Value="#8CFFFFFF"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>

  <Grid>
    <Border x:Name="Shell" Margin="16" CornerRadius="26" Background="Transparent" ClipToBounds="False">
      <Border.Effect>
        <DropShadowEffect BlurRadius="28" ShadowDepth="9" Direction="270" Opacity="0.26" Color="#2A3350"/>
      </Border.Effect>
      <Grid>
        <!-- 玻璃底单独一层：透明度滑条只淡这一层，文字有保底 -->
        <Border x:Name="GlassLayer" CornerRadius="26" BorderThickness="1">
          <Border.BorderBrush>
            <LinearGradientBrush StartPoint="0,0" EndPoint="0.4,1">
              <GradientStop Color="#B3FFFFFF" Offset="0"/>
              <GradientStop Color="#4DFFFFFF" Offset="1"/>
            </LinearGradientBrush>
          </Border.BorderBrush>
          <Border.Background>
            <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
              <GradientStop Color="#66FFFFFF" Offset="0"/>
              <GradientStop Color="#33F0F5FF" Offset="0.55"/>
              <GradientStop Color="#26E9F0FF" Offset="1"/>
            </LinearGradientBrush>
          </Border.Background>
        </Border>

        <Grid x:Name="Content" Margin="20,17,20,14">
          <Grid.RowDefinitions>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="*"/>
            <RowDefinition Height="Auto"/>
          </Grid.RowDefinitions>

          <Grid Grid.Row="0" x:Name="Header">
            <Border x:Name="DateHit" Background="Transparent" Cursor="Hand" HorizontalAlignment="Left" VerticalAlignment="Top" Padding="0,0,14,2" ToolTip="点这里收起 / 展开下方任务列表">
              <StackPanel>
                <TextBlock x:Name="DateText" FontSize="22" FontWeight="Bold" Foreground="#FF262D3D"/>
                <TextBlock x:Name="SubText" Margin="0,5,0,0" FontSize="11.5" Foreground="#FF7C8598"/>
              </StackPanel>
            </Border>
            <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Top">
              <Button x:Name="ModeDay" Content="当日" Style="{StaticResource Chip}"/>
              <Button x:Name="ModeOpen" Content="未完成" Style="{StaticResource Chip}"/>
              <Button x:Name="CollapseBtn" Content="⌃" Style="{StaticResource Chip}" FontSize="10" Padding="7,3" ToolTip="收起 / 展开任务列表"/>
            </StackPanel>
          </Grid>

          <Border Grid.Row="3" x:Name="Sep" Height="1" Margin="0,12,0,0" Background="#2EFFFFFF"/>

          <ScrollViewer Grid.Row="4" x:Name="TaskScroll" Margin="0,7,0,0" VerticalScrollBarVisibility="Auto">
            <StackPanel x:Name="TaskList"/>
          </ScrollViewer>

          <Grid Grid.Row="1" x:Name="CalHead" Margin="0,10,0,0">
            <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
              <Button x:Name="PrevMonth" Content="‹" Style="{StaticResource Nav}"/>
              <TextBlock x:Name="MonthText" Margin="10,0,0,0" FontSize="13.5" FontWeight="SemiBold" Foreground="#FF39415A" VerticalAlignment="Center"/>
              <Button x:Name="NextMonth" Content="›" Style="{StaticResource Nav}" Margin="10,0,0,0"/>
            </StackPanel>
            <Button x:Name="TodayBtn" Content="今天" Style="{StaticResource Chip}" HorizontalAlignment="Right" VerticalAlignment="Center"/>
          </Grid>

          <StackPanel Grid.Row="2" x:Name="CalBody" Margin="0,8,0,0">
            <UniformGrid x:Name="WeekRow" Columns="7"/>
            <UniformGrid x:Name="CalGrid" Columns="7" Rows="6" Margin="0,2,0,0" VerticalAlignment="Top"/>
          </StackPanel>

          <Grid Grid.Row="5" x:Name="Foot" Margin="0,9,0,0">
            <Grid.ColumnDefinitions>
              <ColumnDefinition Width="*"/>
              <ColumnDefinition Width="Auto"/>
            </Grid.ColumnDefinitions>
            <TextBlock Grid.Column="0" x:Name="FootText" FontSize="10.5" Foreground="#FF98A0B2" TextTrimming="CharacterEllipsis" VerticalAlignment="Center"/>
            <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Center">
              <TextBlock Text="透明度" FontSize="9.5" Foreground="#FF98A0B2" VerticalAlignment="Center" Margin="6,0,4,0"/>
              <Slider x:Name="OpacitySlider" Width="72" Height="18" Minimum="0" Maximum="100" Value="100" VerticalAlignment="Center" ToolTip="玻璃底透明度 0-100%，文字保底 15%（鼠标移上去临时回满）"/>
              <TextBlock x:Name="OpacityLabel" Text="100%" FontSize="10" Foreground="#FF7C8598" Width="34" TextAlignment="Right" VerticalAlignment="Center"/>
            </StackPanel>
          </Grid>
        </Grid>

        <Border x:Name="Grip" Width="18" Height="18" HorizontalAlignment="Right" VerticalAlignment="Bottom" Margin="0,0,4,4"
                Background="Transparent" Cursor="SizeNWSE" ToolTip="拖动调整窗口大小">
          <Path Data="M 11,0 L 0,11 M 11,5 L 5,11" Stroke="#CC8B93A6" StrokeThickness="1.5" HorizontalAlignment="Right" VerticalAlignment="Bottom"/>
        </Border>
      </Grid>
    </Border>
  </Grid>
</Window>
'@

$win = [Windows.Markup.XamlReader]::Parse($xaml)
foreach ($n in 'DateText','SubText','TaskScroll','TaskList','MonthText','WeekRow','CalGrid','FootText','ModeDay','ModeOpen','PrevMonth','NextMonth','TodayBtn','Shell','Header','DateHit','GlassLayer','Content','Sep','CalHead','CalBody','Foot','CollapseBtn','OpacitySlider','OpacityLabel','Grip') {
  Set-Variable -Name "ui$n" -Value $win.FindName($n)
}

# ---------- 数据 ----------
function Get-State {
  & $node $setCli 'state' '--file' $stateFile | Out-Null
  $raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $stateFile
  return $raw | ConvertFrom-Json
}
function Set-TaskStatus([string]$id, [string]$status) {
  & $node $setCli $status $id '--file' $stateFile | Out-Null
}

$script:S = Get-State
$script:Collapsed = $false
$script:ExpandedHeight = 800
$script:Shrink = 0
$script:moved = $false
$script:pressOnControl = $false
Write-Log ('读到清单 open=' + $script:S.counts.open + ' done=' + $script:S.counts.done)
$script:Mode = 'day'
$script:Sel = $script:S.today
$script:ViewY = [int]$script:S.today.Substring(0,4)
$script:ViewM = [int]$script:S.today.Substring(5,2)

function Get-WeekdayCN([string]$d) {
  $dt = [datetime]::ParseExact($d, 'yyyy-MM-dd', $null)
  return @('周日','周一','周二','周三','周四','周五','周六')[[int]$dt.DayOfWeek]
}
function New-Text([string]$text, $size, $color, $wrap = $false) {
  $t = New-Object System.Windows.Controls.TextBlock
  $t.Text = $text
  $t.FontSize = $size
  $t.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($color)))
  if ($wrap) { $t.TextWrapping = 'Wrap' }
  return $t
}
function New-Badge([string]$text, [string]$fg, [string]$bg, [string]$border) {
  $b = New-Object System.Windows.Controls.Border
  $b.CornerRadius = New-Object System.Windows.CornerRadius 8
  $b.Padding = New-Object System.Windows.Thickness 6,1,6,2
  $b.Margin = New-Object System.Windows.Thickness 6,0,0,0
  $b.VerticalAlignment = 'Center'
  $b.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($bg))
  $b.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($border))
  $b.BorderThickness = New-Object System.Windows.Thickness 1
  $b.Child = (New-Text $text 10 $fg)
  return $b
}

function New-TaskRow($task) {
  $isDone = ($task.status -eq 'done')
  $row = New-Object System.Windows.Controls.Border
  $row.CornerRadius = New-Object System.Windows.CornerRadius 12
  $row.Padding = New-Object System.Windows.Thickness 8,7,8,7
  $row.Margin = New-Object System.Windows.Thickness 0,1,0,1
  $row.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(0,255,255,255))

  $grid = New-Object System.Windows.Controls.Grid
  $c1 = New-Object System.Windows.Controls.ColumnDefinition; $c1.Width = New-Object System.Windows.GridLength 25
  $c2 = New-Object System.Windows.Controls.ColumnDefinition; $c2.Width = New-Object System.Windows.GridLength 1,'Star'
  $grid.ColumnDefinitions.Add($c1); $grid.ColumnDefinitions.Add($c2)

  $tick = New-Object System.Windows.Controls.Button
  $tick.Style = $win.FindResource($(if ($isDone) { 'TickDone' } else { 'Tick' }))
  $tick.Tag = $task.id
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($tick, 'tick-' + $task.id)
  [System.Windows.Automation.AutomationProperties]::SetName($tick, $(if ($isDone) { '标记未完成' } else { '标记完成' }))
  $tick.Add_Click({
    $id = [string]$this.Tag
    $cur = ($script:S.tasks | Where-Object { $_.id -eq $id } | Select-Object -First 1).status
    Set-TaskStatus $id $(if ($cur -eq 'done') { 'open' } else { 'done' })
    $script:S = Get-State
    Update-Widget
  })
  [System.Windows.Controls.Grid]::SetColumn($tick, 0)
  $grid.Children.Add($tick) | Out-Null

  $body = New-Object System.Windows.Controls.StackPanel
  $titleRow = New-Object System.Windows.Controls.WrapPanel
  $title = New-Text $task.title 13 $(if ($isDone) { '#FF9AA2B4' } else { '#FF262D3D' }) $true
  if ($isDone) { $title.TextDecorations = [System.Windows.TextDecorations]::Strikethrough }
  $titleRow.Children.Add($title) | Out-Null
  if ($task.priority -eq 'high' -and -not $isDone) { $titleRow.Children.Add((New-Badge '高优先' '#FFA5264C' '#8CFFC4D6' '#59E2557B')) | Out-Null }
  if ($task.due) {
    $late = ($task.due -lt $script:S.today -and -not $isDone)
    $titleRow.Children.Add((New-Badge ('截止 ' + $task.due.Substring(5)) $(if ($late) { '#FF8A3B12' } else { '#FF1F5EA8' }) $(if ($late) { '#99FFD6B2' } else { '#8CC4DEFF' }) $(if ($late) { '#61D6833C' } else { '#5291EDF5' }))) | Out-Null
  }
  $body.Children.Add($titleRow) | Out-Null

  $metaBits = @()
  if ($task.requester) { $metaBits += ($task.requester + ' 提') }
  if ($task.source -and $task.source.chat) { $metaBits += ('来自「' + $task.source.chat + '」') }
  if ($isDone -and $task.doneDate) { $metaBits += ('已完成 ' + $task.doneDate.Substring(5)) }
  if ($metaBits.Count) {
    $meta = New-Text ($metaBits -join '  ·  ') 10.5 '#FF98A0B2' $true
    $meta.Margin = New-Object System.Windows.Thickness 0,3,0,0
    $body.Children.Add($meta) | Out-Null
  }
  if ($task.action) {
    $act = New-Text $task.action 11.5 $(if ($isDone) { '#FFA5ADBE' } else { '#FF59627A' }) $true
    $act.Margin = New-Object System.Windows.Thickness 0,4,0,0
    $act.Opacity = 0.95
    $body.Children.Add($act) | Out-Null
  }
  [System.Windows.Controls.Grid]::SetColumn($body, 1)
  $grid.Children.Add($body) | Out-Null

  $row.Child = $grid
  return $row
}

function Update-Widget {
  $S = $script:S
  $byScan = @{}
  $byDue = @{}
  foreach ($t in $S.tasks) {
    if ($t.scanDate) { if (-not $byScan.ContainsKey($t.scanDate)) { $byScan[$t.scanDate] = @() }; $byScan[$t.scanDate] += $t }
    if ($t.due) { if (-not $byDue.ContainsKey($t.due)) { $byDue[$t.due] = @() }; $byDue[$t.due] += $t }
  }

  if ($script:Mode -eq 'day') {
    $sel = $script:Sel
    $uiDateText.Text = ((Get-WeekdayCN $sel) + '  ' + [int]$sel.Substring(5,2) + ' 月 ' + [int]$sel.Substring(8,2) + ' 日')
    $list = @()
    if ($byScan.ContainsKey($sel)) { $list = @($byScan[$sel]) }
    $list = @($list | Sort-Object @{Expression={ if ($_.status -eq 'done') { '1' } else { '0' } }}, @{Expression={ if ($_.due) { $_.due } else { '9999-99-99' } }}, @{Expression={ if ($_.priority -eq 'high') { '0' } elseif ($_.priority -eq 'low') { '2' } else { '1' } }}, @{Expression={ $_.title }})
    $extra = @()
    if ($byDue.ContainsKey($sel)) { $extra = @($byDue[$sel] | Where-Object { $_.status -eq 'open' -and $_.scanDate -ne $sel }) }
  } else {
    $uiDateText.Text = '全部未完成'
    $list = @($S.tasks | Where-Object { $_.status -eq 'open' } | Sort-Object @{Expression={ if ($_.due) { $_.due } else { '9999-99-99' } }}, @{Expression={ if ($_.priority -eq 'high') { '0' } elseif ($_.priority -eq 'low') { '2' } else { '1' } }}, @{Expression={ $_.title }})
    $extra = @()
  }
  $uiSubText.Text = "扫描到 $($list.Count) 条 · 未完成 $($S.counts.open) · 已完成 $($S.counts.done)"

  $uiModeDay.Style = $win.FindResource($(if ($script:Mode -eq 'day') { 'ChipOn' } else { 'Chip' }))
  $uiModeOpen.Style = $win.FindResource($(if ($script:Mode -eq 'open') { 'ChipOn' } else { 'Chip' }))

  $uiTaskList.Children.Clear()
  if (-not $list.Count) {
    $empty = New-Text $(if ($script:Mode -eq 'day') { '这一天没有扫描到新任务' } else { '没有未完成的任务，收工' }) 12 '#FF98A0B2'
    $empty.Margin = New-Object System.Windows.Thickness 6,16,0,16
    $uiTaskList.Children.Add($empty) | Out-Null
  }
  foreach ($t in $list) { $uiTaskList.Children.Add((New-TaskRow $t)) | Out-Null }
  if ($extra.Count) {
    $sep = New-Text ("另有 $($extra.Count) 条这天到期：") 10.5 '#FF98A0B2'
    $sep.Margin = New-Object System.Windows.Thickness 6,10,0,2
    $uiTaskList.Children.Add($sep) | Out-Null
    foreach ($t in $extra) { $uiTaskList.Children.Add((New-TaskRow $t)) | Out-Null }
  }

  # 迷你月历
  $uiMonthText.Text = "$($script:ViewY) 年 $($script:ViewM) 月"
  $uiWeekRow.Children.Clear()
  foreach ($w in '一','二','三','四','五','六','日') {
    $t = New-Text $w 10 '#FF98A0B2'
    $t.HorizontalAlignment = 'Center'
    $t.Margin = New-Object System.Windows.Thickness 0,0,0,3
    $uiWeekRow.Children.Add($t) | Out-Null
  }

  $uiCalGrid.Children.Clear()
  $first = Get-Date -Year $script:ViewY -Month $script:ViewM -Day 1
  $lead = (([int]$first.DayOfWeek) + 6) % 7
  $days = [datetime]::DaysInMonth($script:ViewY, $script:ViewM)
  for ($i = 0; $i -lt $lead; $i++) {
    $b = New-Object System.Windows.Controls.Border
    $uiCalGrid.Children.Add($b) | Out-Null
  }
  for ($d = 1; $d -le $days; $d++) {
    $key = "{0:d4}-{1:d2}-{2:d2}" -f $script:ViewY, $script:ViewM, $d
    $cell = New-Object System.Windows.Controls.Button
    $cell.Style = $win.FindResource('Cell')
    $cell.Tag = $key
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($cell, 'day-' + $key)
    if ($key -eq $S.today) {
      $cell.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#8C5B8DEF'))
      $cell.BorderThickness = New-Object System.Windows.Thickness 1.4
    }
    if ($key -eq $script:Sel) {
      $cell.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#F2FFFFFF'))
    }
    $cell.Add_Click({
      $script:Sel = [string]$this.Tag
      $script:Mode = 'day'
      Update-Widget
    })

    $stack = New-Object System.Windows.Controls.StackPanel
    $num = New-Text ([string]$d) 10.5 $(if ($key -eq $S.today) { '#FF3B6FD4' } else { '#FF7C8598' })
    $num.HorizontalAlignment = 'Left'
    $num.FontWeight = 'SemiBold'
    $stack.Children.Add($num) | Out-Null

    if ($byScan.ContainsKey($key)) {
      $dots = New-Object System.Windows.Controls.WrapPanel
      $dots.Margin = New-Object System.Windows.Thickness 0,2,0,0
      $shown = 0
      foreach ($t in $byScan[$key]) {
        if ($shown -ge 4) { break }
        $e = New-Object System.Windows.Shapes.Ellipse
        $e.Width = 5; $e.Height = 5
        $e.Margin = New-Object System.Windows.Thickness 0,0,3,0
        $fill = if ($t.status -eq 'done') { '#00000000' } elseif ($t.priority -eq 'high') { '#FFE2557B' } elseif ($t.priority -eq 'low') { '#FF9AA7BD' } else { '#FF5B8DEF' }
        $e.Fill = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($fill))
        if ($t.status -eq 'done') {
          $e.Stroke = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString('#FF9AA7BD'))
          $e.StrokeThickness = 1.2
        }
        $dots.Children.Add($e) | Out-Null
        $shown++
      }
      if ($byScan[$key].Count -gt 4) {
        $more = New-Text ('+' + ($byScan[$key].Count - 4)) 8 '#FF98A0B2'
        $dots.Children.Add($more) | Out-Null
      }
      $stack.Children.Add($dots) | Out-Null
    }
    if ($byDue.ContainsKey($key)) {
      $openDue = @($byDue[$key] | Where-Object { $_.status -eq 'open' })
      if ($openDue.Count) {
        $badge = New-Text ($openDue.Count.ToString() + ' 到期') 8.5 $(if ($key -lt $S.today) { '#FF8A3B12' } else { '#FF1F5EA8' })
        $badge.Margin = New-Object System.Windows.Thickness 0,2,0,0
        $stack.Children.Add($badge) | Out-Null
      }
    }
    $cell.Content = $stack
    $uiCalGrid.Children.Add($cell) | Out-Null
  }
  $pad = 42 - $lead - $days
  for ($i = 0; $i -lt $pad; $i++) {
    $b = New-Object System.Windows.Controls.Border
    $uiCalGrid.Children.Add($b) | Out-Null
  }

  $upd = '—'
  if ($S.updatedAt) { $upd = ([datetime]$S.updatedAt).ToLocalTime().ToString('MM-dd HH:mm') }
  $uiFootText.Text = "$upd 扫描 · 点圆圈完成 · 右键更多"
}

# ---------- 交互 ----------
$uiModeDay.Add_Click({ if ($script:Collapsed) { Set-Collapsed $false }; $script:Mode = 'day'; Update-Widget })
$uiModeOpen.Add_Click({ if ($script:Collapsed) { Set-Collapsed $false }; $script:Mode = 'open'; Update-Widget })
$uiPrevMonth.Add_Click({ $script:ViewM--; if ($script:ViewM -lt 1) { $script:ViewM = 12; $script:ViewY-- }; Update-Widget })
$uiNextMonth.Add_Click({ $script:ViewM++; if ($script:ViewM -gt 12) { $script:ViewM = 1; $script:ViewY++ }; Update-Widget })
$uiTodayBtn.Add_Click({ $script:Sel = $script:S.today; $script:ViewY = [int]$script:Sel.Substring(0,4); $script:ViewM = [int]$script:Sel.Substring(5,2); $script:Mode='day'; Update-Widget })

function Test-OnControl($src) {
  $node = $src
  while ($node -and ($node -ne $win)) {
    if ($node -is [System.Windows.Controls.Primitives.Thumb]) { return $true }
    if ($node -is [System.Windows.Controls.Slider]) { return $true }
    if ($node -is [System.Windows.Controls.Button]) { return $true }
    if ($node -is [System.Windows.Controls.Primitives.ScrollBar]) { return $true }
    if ($node -is [System.Windows.FrameworkElement] -and $node.Name -eq 'Grip') { return $true }
    try { $node = [System.Windows.Media.VisualTreeHelper]::GetParent($node) } catch { return $false }
  }
  return $false
}

$uiShell.Add_MouseLeftButtonDown({
  param($s, $e)
  $script:moved = $false
  $script:dragStart = $e.GetPosition($s)
  $script:pressOnControl = (Test-OnControl $e.OriginalSource)
})
$uiShell.Add_MouseMove({
  param($s, $e)
  if ($script:pressOnControl) { return }
  if ($e.LeftButton -ne 'Pressed' -or -not $script:dragStart) { return }
  $pt = $e.GetPosition($s)
  if ([math]::Abs($pt.X - $script:dragStart.X) -gt 3 -or [math]::Abs($pt.Y - $script:dragStart.Y) -gt 3) {
    $script:moved = $true
    $script:dragStart = $null
    try { $win.DragMove() } catch { }
    Save-Pos
  }
})
$uiShell.Add_MouseLeftButtonUp({ param($s, $e) $script:dragStart = $null })

function Save-Pos {
  if ($testMode) { return }   # 自检/渲染不落盘，别覆盖真实偏好
  $obj = @{
    x = [int]$win.Left; y = [int]$win.Top
    width = [int]$win.Width; height = [int]$win.Height
    topmost = [bool]$win.Topmost
    opacity = [int]$uiOpacitySlider.Value
    collapsed = [bool]$script:Collapsed
    expandedHeight = [int]$script:ExpandedHeight
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText($posFile, $obj, [System.Text.Encoding]::UTF8)
}

# 右键菜单
$cm = New-Object System.Windows.Controls.ContextMenu
$miTop = New-Object System.Windows.Controls.MenuItem
$miTop.Header = '置顶显示'; $miTop.IsCheckable = $true; $miTop.IsChecked = $true
$miTop.Add_Click({ $win.Topmost = -not $win.Topmost; $miTop.IsChecked = $win.Topmost; Save-Pos })
$miGlass = New-Object System.Windows.Controls.MenuItem
$miGlass.Header = '磨砂玻璃（DWM 毛玻璃）'
$miGlass.IsCheckable = $true
$miGlass.IsChecked = $script:glassOn
$miGlass.Add_Click({ $script:glassOn = $miGlass.IsChecked; Apply-Accent ($uiOpacitySlider.Value / 100.0); Write-Log ('磨砂开关 -> ' + $script:glassOn) })
$miRefresh = New-Object System.Windows.Controls.MenuItem
$miRefresh.Header = '立即刷新'
$miRefresh.Add_Click({ $script:S = Get-State; Update-Widget })
$miStartup = New-Object System.Windows.Controls.MenuItem
$miStartup.Header = '开机自启'
$miStartup.IsCheckable = $true
$startupDir = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startupDir '飞书任务便签.lnk'
$miStartup.IsChecked = (Test-Path $lnkPath)
$miStartup.Add_Click({
  if (Test-Path $lnkPath) {
    Remove-Item $lnkPath -Force
    $miStartup.IsChecked = $false
  } else {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($lnkPath)
    $lnk.TargetPath = $launcher
    $lnk.WorkingDirectory = $here
    $lnk.WindowStyle = 7
    $lnk.Save()
    $miStartup.IsChecked = $true
  }
})
$miResetPos = New-Object System.Windows.Controls.MenuItem
$miResetPos.Header = '重置窗口位置'
$miResetPos.Add_Click({
  $w = [System.Windows.SystemParameters]::WorkArea
  $win.Left = $w.Right - $win.Width - 12
  $win.Top = $w.Bottom - $win.Height - 12
  $win.Topmost = $true
  $miTop.IsChecked = $true
  Save-Pos
})
$miOpenDir = New-Object System.Windows.Controls.MenuItem
$miOpenDir.Header = '打开提醒清单文件夹'
$miOpenDir.Add_Click({ Start-Process explorer.exe (Join-Path $here 'reminders') })
$miExit = New-Object System.Windows.Controls.MenuItem
$miExit.Header = '退出'
$miExit.Add_Click({ $win.Close() })
$cm.Items.Add($miTop) | Out-Null
$cm.Items.Add($miGlass) | Out-Null
$cm.Items.Add($miRefresh) | Out-Null
$cm.Items.Add($miStartup) | Out-Null
$cm.Items.Add((New-Object System.Windows.Controls.Separator)) | Out-Null
$cm.Items.Add($miResetPos) | Out-Null
$cm.Items.Add($miOpenDir) | Out-Null
$cm.Items.Add($miExit) | Out-Null
$win.ContextMenu = $cm

# 定时刷新
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(60)
$timer.Add_Tick({ $script:S = Get-State; Update-Widget })
$timer.Start()

# 初始位置：记住上次；否则贴右下角
# 注意：WPF 的 Left/Top/Width/Height 都是 DIP，必须用 SystemParameters.WorkArea（也是 DIP），
# 混用 WinForms 的物理像素会在 175%/200% 缩放下把窗口算到屏幕外（表现为「启动了但看不见」）
$wa = [System.Windows.SystemParameters]::WorkArea
$win.Height = [Math]::Max(420, [Math]::Min($win.Height, $wa.Height - 40))
$pos = $null
if (Test-Path $posFile) {
  try { $pos = Get-Content -Raw -Encoding UTF8 $posFile | ConvertFrom-Json } catch { }
}
if ($pos) {
  $win.Left = [double]$pos.x
  $win.Top = [double]$pos.y
  if ($null -ne $pos.topmost) { $win.Topmost = [bool]$pos.topmost; $miTop.IsChecked = $win.Topmost }
} else {
  $win.Left = $wa.Right - $win.Width - 12
  $win.Top = $wa.Bottom - $win.Height - 12
}
# 无论记住的位置还是默认位置，都夹回可见工作区（跨显示器/改缩放/旧文件都可能越界）
$win.Left = [Math]::Max($wa.Left, [Math]::Min($win.Left, ($wa.Right - $win.Width - 8)))
$win.Top = [Math]::Max($wa.Top, [Math]::Min($win.Top, ($wa.Bottom - $win.Height - 8)))
Write-Log ('窗口位置 ' + [int]$win.Left + ',' + [int]$win.Top + ' 尺寸 ' + [int]$win.Width + 'x' + [int]$win.Height + ' 工作区 ' + [int]$wa.Width + 'x' + [int]$wa.Height + ' topmost=' + $win.Topmost)

# ---------- DWM 磨砂层 ----------
# 关键：窗口内容再透明，底下那层 acrylic 仍是白的；所以磨砂也要跟着透明度走，
# 0% 时把磨砂整个关掉（state 0），才是真正的透到桌面。
function Apply-Accent([double]$g) {
  if ($script:hwnd -eq [IntPtr]::Zero) { return }
  if (-not $script:glassOn) {
    [W32]::Glass($script:hwnd, 0, 0) | Out-Null
    Write-Log '磨砂层已关闭（菜单里关的）'
    return
  }
  if ($g -le 0.02) {
    [W32]::Glass($script:hwnd, 0, 0) | Out-Null
    Write-Log '磨砂层 accent=0（滑条 0%，真透明）'
    return
  }
  $alpha = [int]([Math]::Min(0xB8, [Math]::Round(0xB8 * [Math]::Min(1.0, $g))))
  $tintLong = ([int64]$alpha -shl 24) -bor 0x00F2F6FF
  if ($tintLong -gt 2147483647) { $tintLong = $tintLong - 4294967296 }
  $tint = [int]$tintLong
  if ([W32]::Glass($script:hwnd, 4, $tint) -eq 0) { [W32]::Glass($script:hwnd, 3, $tint) | Out-Null }
  Write-Log ('磨砂层 accent=4 白雾alpha=' + $alpha + ' (滑条 ' + [int]($g * 100) + '%)')
}

# ---------- 透明度 / 收起展开 / 拖拽改尺寸 ----------
function Apply-Glass([double]$v, [bool]$hover) {
  $g = [Math]::Max(0.0, [Math]::Min(1.0, $v))
  $glassShow = $g
  $textShow = [Math]::Max(0.15, $g)   # 文字保底 15%
  if ($hover) {
    $glassShow = [Math]::Min(1.0, $g + 0.35)
    $textShow = 1.0
  }
  $uiGlassLayer.Opacity = $glassShow
  $uiContent.Opacity = $textShow
  try { $uiShell.Effect.Opacity = 0.26 * $glassShow } catch { }   # 阴影跟着玻璃淡，0% 时不剩一圈浮影
  Apply-Accent $glassShow
}

function Set-Collapsed([bool]$want) {
  if ($script:Collapsed -eq $want) { return }
  if ($want) {
    $script:Shrink = $uiTaskScroll.ActualHeight + $uiSep.ActualHeight + $uiSep.Margin.Top
    if ($script:Shrink -lt 60) { $script:Shrink = 60 }
    if ($script:ExpandedHeight -le 0) { $script:ExpandedHeight = $win.Height }
    $uiTaskScroll.Visibility = 'Collapsed'
    $uiSep.Visibility = 'Collapsed'
    $uiCollapseBtn.Content = '⌄'
    $win.Height = [Math]::Max($win.MinHeight, $win.Height - $script:Shrink)
    $script:Collapsed = $true
    Write-Log ('收起任务列表，高度 ' + [int]$win.Height + '（展开时 ' + [int]$script:ExpandedHeight + '）')
  } else {
    $uiTaskScroll.Visibility = 'Visible'
    $uiSep.Visibility = 'Visible'
    $uiCollapseBtn.Content = '⌃'
    $win.Height = [Math]::Max($win.MinHeight, $script:ExpandedHeight)
    $script:Collapsed = $false
    Write-Log ('展开任务列表，高度 ' + [int]$win.Height)
  }
  Save-Pos
}

$uiOpacitySlider.Add_ValueChanged({
  $uiOpacityLabel.Text = ([int]$uiOpacitySlider.Value).ToString() + '%'
  Apply-Glass ($uiOpacitySlider.Value / 100.0) $false
})
$uiShell.Add_MouseEnter({ Apply-Glass ($uiOpacitySlider.Value / 100.0) $true })
$uiShell.Add_MouseLeave({ Apply-Glass ($uiOpacitySlider.Value / 100.0) $false })

$uiDateHit.Add_MouseLeftButtonUp({ if (-not $script:moved) { Set-Collapsed (-not $script:Collapsed) } })
$uiCollapseBtn.Add_Click({ Set-Collapsed (-not $script:Collapsed) })

$script:rs = $null
$uiGrip.Add_MouseLeftButtonDown({
  param($s, $e)
  $script:rs = @{ p = $e.GetPosition($win); w = $win.Width; h = $win.Height }
  [void]$s.CaptureMouse()
  $e.Handled = $true
})
$uiGrip.Add_MouseMove({
  param($s, $e)
  if (-not $script:rs) { return }
  if ($e.LeftButton -ne 'Pressed') { return }
  $workArea = [System.Windows.SystemParameters]::WorkArea
  $pt = $e.GetPosition($win)
  $nw = $script:rs.w + ($pt.X - $script:rs.p.X)
  $nh = $script:rs.h + ($pt.Y - $script:rs.p.Y)
  $win.Width = [Math]::Max($win.MinWidth, [Math]::Min($nw, $workArea.Width - 24))
  $win.Height = [Math]::Max($win.MinHeight, [Math]::Min($nh, $workArea.Height - 24))
  $e.Handled = $true
})
$uiGrip.Add_MouseLeftButtonUp({
  param($s, $e)
  $script:rs = $null
  [void]$s.ReleaseMouseCapture()
  if ($script:Collapsed) { $script:ExpandedHeight = $win.Height + $script:Shrink }
  Save-Pos
  $e.Handled = $true
})

# 恢复上次的尺寸 / 透明度 / 收起状态
if ($pos) {
  if ($pos.width) { $win.Width = [Math]::Max($win.MinWidth, [double]$pos.width) }
  if ($null -ne $pos.expandedHeight) { $script:ExpandedHeight = [Math]::Max($win.MinHeight, [double]$pos.expandedHeight) }
  elseif ($pos.height) { $script:ExpandedHeight = [Math]::Max($win.MinHeight, [double]$pos.height) }
  if ($script:ExpandedHeight -gt 0) { $win.Height = $script:ExpandedHeight }
  if ($null -ne $pos.opacity) { $uiOpacitySlider.Value = [Math]::Max(0, [Math]::Min(100, [double]$pos.opacity)) }
}
$wa2 = [System.Windows.SystemParameters]::WorkArea
$win.Left = [Math]::Max($wa2.Left, [Math]::Min($win.Left, ($wa2.Right - $win.Width - 8)))
$win.Top = [Math]::Max($wa2.Top, [Math]::Min($win.Top, ($wa2.Bottom - $win.Height - 8)))
if (-not $pos) { $script:ExpandedHeight = $win.Height }
if ($StartOpacity -ge 0) { $uiOpacitySlider.Value = [Math]::Max(0, [Math]::Min(100, $StartOpacity)) }
Apply-Glass ($uiOpacitySlider.Value / 100.0) $false
Write-Log ('尺寸 ' + [int]$win.Width + 'x' + [int]$win.Height + ' 透明度 ' + [int]$uiOpacitySlider.Value + '% 位置 ' + [int]$win.Left + ',' + [int]$win.Top)

$win.Add_Loaded({
  Write-Log ('Loaded 触发 StartCollapsed=' + $StartCollapsed + ' posCollapsed=' + $(if ($pos) { $pos.collapsed } else { 'n/a' }) + ' taskH=' + [int]$uiTaskScroll.ActualHeight)
  if ($StartCollapsed -or ($pos -and $pos.collapsed)) { Set-Collapsed $true }
  Write-Log ('Loaded 处理后 高度=' + [int]$win.Height + ' collapsed=' + $script:Collapsed)
})
$win.Add_Closing({
  Save-Pos
  $script:timer.Stop()
  try { if ((Get-Content -Raw -LiteralPath $pidFile -ErrorAction SilentlyContinue) -match ('^' + $PID)) { Remove-Item -LiteralPath $pidFile -Force } } catch { }
})

# 毛玻璃
$win.Add_SourceInitialized({
  $script:hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
  Write-Log ('窗口句柄 ' + $script:hwnd + ' 磨砂开关=' + $script:glassOn)
  Apply-Accent ($uiOpacitySlider.Value / 100.0)
})

try {
Update-Widget
} catch {
  $errText = ($_ | Out-String) + [Environment]::NewLine + $_.ScriptStackTrace
  Write-Log ('运行出错：' + $errText)
  [System.Windows.MessageBox]::Show($errText, '飞书任务便签 - 出错', 'OK', 'Error') | Out-Null
  exit 1
}

if ($RenderTo -or $SelfTest) {
  $win.Show()
  $win.UpdateLayout()
  if ($RenderTo) {
    $dpi = [System.Windows.Media.VisualTreeHelper]::GetDpi($win)
    $w = [int]($win.ActualWidth * $dpi.DpiScaleX)
    $h = [int]($win.ActualHeight * $dpi.DpiScaleY)
    $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap $w, $h, (96 * $dpi.DpiScaleX), (96 * $dpi.DpiScaleY), ([System.Windows.Media.PixelFormats]::Pbgra32)
    $rtb.Render($win)
    $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
    $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($rtb))
    $fsOut = [System.IO.File]::Create($RenderTo)
    $enc.Save($fsOut)
    $fsOut.Close()
    'rendered ' + $w + 'x' + $h + ' -> ' + $RenderTo + ' (' + (Get-Item $RenderTo).Length + 'B)'
  }
  if ($SelfTest) {
    $btn = $null
    foreach ($child in $uiTaskList.Children) {
      $found = $null
      if ($child -is [System.Windows.Controls.Border] -and $child.Child -is [System.Windows.Controls.Grid]) {
        foreach ($gc in $child.Child.Children) { if ($gc -is [System.Windows.Controls.Button]) { $found = $gc; break } }
      }
      if ($found) { $btn = $found; break }
    }
    if (-not $btn) { 'SELFTEST: 没找到任务行' } else {
      $id = [string]$btn.Tag
      'SELFTEST click ' + $id + ' (before open=' + $script:S.counts.open + ')'
      $btn.RaiseEvent((New-Object System.Windows.RoutedEventArgs([System.Windows.Controls.Primitives.ButtonBase]::ClickEvent)))
      'SELFTEST after click open=' + $script:S.counts.open
      $script:S = Get-State
      Update-Widget
      $btn2 = $null
      foreach ($child in $uiTaskList.Children) {
        $found = $null
        if ($child -is [System.Windows.Controls.Border] -and $child.Child -is [System.Windows.Controls.Grid]) {
          foreach ($gc in $child.Child.Children) { if ($gc -is [System.Windows.Controls.Button] -and [string]$gc.Tag -eq $id) { $found = $gc; break } }
        }
        if ($found) { $btn2 = $found; break }
      }
      if ($btn2) {
        $btn2.RaiseEvent((New-Object System.Windows.RoutedEventArgs([System.Windows.Controls.Primitives.ButtonBase]::ClickEvent)))
        'SELFTEST restored open=' + $script:S.counts.open
      } else { 'SELFTEST: 恢复时没找到同一行（可能已滚出当日列表）' }
    }
  }
  $win.Close()
  exit 0
}

Write-Log '窗口已创建，进入消息循环'
try {
  $win.ShowDialog() | Out-Null
} catch {
  $errText = ($_ | Out-String) + [Environment]::NewLine + $_.ScriptStackTrace
  Write-Log ('消息循环出错：' + $errText)
  [System.Windows.MessageBox]::Show($errText, '飞书任务便签 - 出错', 'OK', 'Error') | Out-Null
  exit 1
}
