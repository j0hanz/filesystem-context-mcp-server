$files = Get-ChildItem -Path src, __tests__ -Recurse -Filter *.ts
foreach ($file in $files) {
    $content = [System.IO.File]::ReadAllText($file.FullName)
    $newContent = $content
    
    # Replace old module paths with new consolidated ones
    $newContent = $newContent -replace "from '['\"]\.\.+/core/constants\.js['\"]", "from '../core/util.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/constants\.js['\"]", "from '../core/util.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/utils\.js['\"]", "from '../core/util.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/utils\.js['\"]", "from '../core/util.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/logger\.js['\"]", "from '../core/observability.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/logger\.js['\"]", "from '../core/observability.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/path-guard\.js['\"]", "from '../core/path.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/path-guard\.js['\"]", "from '../core/path.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/path-completer\.js['\"]", "from '../core/path.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/path-completer\.js['\"]", "from '../core/path.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/parallel\.js['\"]", "from '../core/concurrency.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/parallel\.js['\"]", "from '../core/concurrency.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/worker-pool\.js['\"]", "from '../core/concurrency.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/worker-pool\.js['\"]", "from '../core/concurrency.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/abort\.js['\"]", "from '../core/concurrency.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/abort\.js['\"]", "from '../core/concurrency.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/file-content\.js['\"]", "from '../core/fs.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/file-content\.js['\"]", "from '../core/fs.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/atomic-write\.js['\"]", "from '../core/fs.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/atomic-write\.js['\"]", "from '../core/fs.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/fs-walk\.js['\"]", "from '../core/fs.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/fs-walk\.js['\"]", "from '../core/fs.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/mime\.js['\"]", "from '../core/fs.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/mime\.js['\"]", "from '../core/fs.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/progress-session\.js['\"]", "from '../core/observability.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/progress-session\.js['\"]", "from '../core/observability.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/zod-codecs\.js['\"]", "from '../core/path.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/zod-codecs\.js['\"]", "from '../core/path.js'"
    $newContent = $newContent -replace "from '['\"]\.\.+/core/worker\.js['\"]", "from '../core/concurrency.js'"
    $newContent = $newContent -replace "from '['\"]\./*core/worker\.js['\"]", "from '../core/concurrency.js'"
    
    if ($content -ne $newContent) {
        [System.IO.File]::WriteAllText($file.FullName, $newContent)
        Write-Host "Fixed: $($file.Name)"
    }
}
Write-Host "Import fixes complete"
