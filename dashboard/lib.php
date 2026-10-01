<?php
declare(strict_types=1);
date_default_timezone_set('Asia/Tokyo');

function cfg(): array
{
    static $c = null;
    if ($c === null) {
        $f = __DIR__ . '/config.php';
        if (!is_file($f)) {
            http_response_code(500);
            exit('config.php がありません（GitHub Actions のデプロイで生成されます）');
        }
        $c = require $f;
        if (empty($c['password']) || empty($c['bot_token'])) {
            http_response_code(500);
            exit('config.php の password / bot_token が空です');
        }
    }
    return $c;
}

function data_dir(): string
{
    $d = __DIR__ . '/data';
    if (!is_dir($d)) {
        mkdir($d, 0700, true);
    }
    $ht = $d . '/.htaccess';
    if (!is_file($ht)) {
        file_put_contents($ht, "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
    }
    return $d;
}

function read_json(string $name, array $default): array
{
    $f = data_dir() . "/$name.json";
    if (!is_file($f)) {
        return $default;
    }
    $j = json_decode((string)file_get_contents($f), true);
    return is_array($j) ? $j : $default;
}

function write_json(string $name, array $value): void
{
    file_put_contents(
        data_dir() . "/$name.json",
        json_encode($value, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT),
        LOCK_EX
    );
}

// 「全部引き上げ」を指示したが、Bot がまだ実行していない状態か
function exit_pending(array $control, array $status): bool
{
    if (empty($control['exit_at'])) {
        return false;
    }
    // 古い Bot（完了を報告しない版）の場合は判定できないので制限しない
    if (!array_key_exists('handledExitAt', $status)) {
        return false;
    }
    return (int)($status['handledExitAt'] ?? 0) !== (int)$control['exit_at'];
}

function h($s): string
{
    return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
}

function num($v, int $decimals = 2): string
{
    return is_numeric($v) ? number_format((float)$v, $decimals) : '-';
}
