<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';

session_set_cookie_params([
    'httponly' => true,
    'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'samesite' => 'Strict',
]);
session_start();

// ---- ログアウト ----
if (isset($_GET['logout'])) {
    $_SESSION = [];
    session_destroy();
    header('Location: ./');
    exit;
}

// ---- ログイン ----
$loginError = '';
if (empty($_SESSION['auth'])) {
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && isset($_POST['password'])) {
        if (hash_equals((string)cfg()['password'], (string)$_POST['password'])) {
            session_regenerate_id(true);
            $_SESSION['auth'] = true;
            $_SESSION['csrf'] = bin2hex(random_bytes(16));
            header('Location: ./');
            exit;
        }
        sleep(2);
        $loginError = 'パスワードが違います';
    }
    ?>
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>LP Bot ログイン</title>
<link rel="stylesheet" href="style.css">
</head>
<body class="login">
<form method="post" class="card">
  <h1>LP Bot</h1>
  <?php if ($loginError): ?><p class="err"><?= h($loginError) ?></p><?php endif; ?>
  <input type="password" name="password" placeholder="パスワード" autofocus required>
  <button type="submit">ログイン</button>
</form>
</body>
</html>
    <?php
    exit;
}

// ---- 一時停止 / 再開 / 全部引き上げ ----
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && isset($_POST['action'])) {
    if (!hash_equals($_SESSION['csrf'] ?? '', (string)($_POST['csrf'] ?? ''))) {
        http_response_code(400);
        exit('invalid request');
    }
    $current = read_json('control', ['paused' => false, 'exit_at' => null]);
    switch ($_POST['action']) {
        case 'pause':
            $next = ['paused' => true, 'exit_at' => $current['exit_at'] ?? null];
            break;
        case 'resume':
            $next = ['paused' => false, 'exit_at' => null];
            break;
        case 'exit':
            // 全ポジションを解除して一時停止
            $next = ['paused' => true, 'exit_at' => time()];
            break;
        default:
            http_response_code(400);
            exit('invalid action');
    }
    $next['changed_at'] = time();
    write_json('control', $next);
    header('Location: ./');
    exit;
}

$status = read_json('status', []);
$control = read_json('control', ['paused' => false]);
$pool = $status['pool'] ?? null;
$pair = $pool ? $pool['symbol0'] . '/' . $pool['symbol1'] : '-';
$sym1 = $pool['symbol1'] ?? '';
$age = isset($status['received_at']) ? time() - (int)$status['received_at'] : null;
$interval = (int)($status['settings']['pollIntervalSec'] ?? 60);
$stale = $age === null || $age > max(300, $interval * 5);
$positions = $status['positions'] ?? [];
$totalValue = array_sum(array_column($positions, 'valueInToken1'));
$totalFees = array_sum(array_column($positions, 'feesInToken1'));
?>
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="refresh" content="60">
<title>LP Bot 管理画面</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header>
  <h1>LP Bot</h1>
  <a href="?logout=1" class="muted">ログアウト</a>
</header>

<main>
  <section class="bar">
    <?php if ($age === null): ?>
      <span class="badge bad">Bot からのデータ未受信</span>
    <?php elseif ($stale): ?>
      <span class="badge bad">Bot 停止の可能性（最終受信 <?= h(floor($age / 60)) ?> 分前）</span>
    <?php else: ?>
      <span class="badge ok">稼働中（<?= h($age) ?> 秒前に受信）</span>
    <?php endif; ?>
    <?php if (($status['mode'] ?? '') === 'live'): ?>
      <span class="badge bad">実取引モード</span>
    <?php else: ?>
      <span class="badge">監視モード（取引しない）</span>
    <?php endif; ?>
    <span class="badge <?= $control['paused'] ? 'warn' : '' ?>"><?= $control['paused'] ? '一時停止中' : '自動 有効' ?></span>
    <?php if (!empty($control['exit_at'])): ?>
      <span class="badge warn">引き上げ指示済み</span>
    <?php endif; ?>
    <?php if (!empty($status['halted'])): ?>
      <span class="badge bad">連続失敗で自動停止中（一時停止→再開で解除）</span>
    <?php endif; ?>
    <div class="actions">
      <form method="post" class="inline">
        <input type="hidden" name="csrf" value="<?= h($_SESSION['csrf'] ?? '') ?>">
        <input type="hidden" name="action" value="<?= $control['paused'] ? 'resume' : 'pause' ?>">
        <button type="submit"><?= $control['paused'] ? '再開する' : '一時停止する' ?></button>
      </form>
      <?php if (($status['mode'] ?? '') === 'live'): ?>
      <form method="post" class="inline" onsubmit="return confirm('すべてのポジションを解除して、資金をウォレットに戻します。よろしいですか？');">
        <input type="hidden" name="csrf" value="<?= h($_SESSION['csrf'] ?? '') ?>">
        <input type="hidden" name="action" value="exit">
        <button type="submit" class="danger">全部引き上げる</button>
      </form>
      <?php endif; ?>
    </div>
  </section>

  <section class="grid">
    <div class="card"><div class="label">プール</div><div class="big"><?= h($pair) ?></div>
      <div class="muted"><?= h($status['chain'] ?? '') ?> · fee <?= $pool ? h($pool['fee'] / 10000) . '%' : '-' ?></div></div>
    <div class="card"><div class="label">現在価格</div><div class="big"><?= num($pool['price'] ?? null) ?></div>
      <div class="muted"><?= h($sym1) ?> / 1 <?= h($pool['symbol0'] ?? '') ?> · tick <?= h($pool['tick'] ?? '-') ?></div></div>
    <div class="card"><div class="label">ポジション評価額</div><div class="big"><?= num($totalValue) ?></div>
      <div class="muted"><?= h($sym1) ?> 建て</div></div>
    <div class="card"><div class="label">未回収手数料</div><div class="big"><?= num($totalFees, 4) ?></div>
      <div class="muted"><?= h($sym1) ?> 建て</div></div>
  </section>

  <section class="card">
    <h2>ポジション</h2>
    <?php if (!$positions): ?>
      <p class="muted">このプールのポジションはありません。</p>
    <?php else: ?>
    <div class="scroll"><table>
      <tr><th>ID</th><th>状態</th><th>レンジ</th><th><?= h($pool['symbol0'] ?? '') ?></th><th><?= h($sym1) ?></th><th>手数料</th><th>評価額</th></tr>
      <?php foreach ($positions as $p): ?>
      <tr>
        <td>#<?= h($p['tokenId']) ?></td>
        <td><span class="badge <?= $p['inRange'] ? 'ok' : 'bad' ?>"><?= $p['inRange'] ? 'レンジ内' : 'レンジ外' ?></span></td>
        <td><?= num($p['priceLower']) ?> 〜 <?= num($p['priceUpper']) ?></td>
        <td><?= num($p['amount0'], 6) ?></td>
        <td><?= num($p['amount1'], 2) ?></td>
        <td><?= num($p['fees0'], 6) ?> / <?= num($p['fees1'], 2) ?></td>
        <td><?= num($p['valueInToken1']) ?></td>
      </tr>
      <?php endforeach; ?>
    </table></div>
    <?php endif; ?>
    <?php if (!empty($status['proposedRange'])): $r = $status['proposedRange']; ?>
      <p class="muted">現在価格で作る場合のレンジ案（±<?= h($status['settings']['rangeWidthPct'] ?? '') ?>%）:
        <?= num($r['priceLower']) ?> 〜 <?= num($r['priceUpper']) ?></p>
    <?php endif; ?>
  </section>

  <section class="grid2">
    <div class="card">
      <h2>ウォレット残高</h2>
      <p class="muted mono"><?= h($status['wallet'] ?? '-') ?></p>
      <table>
        <?php foreach ($status['balances'] ?? [] as $b): ?>
          <tr><td><?= h($b['symbol']) ?></td><td class="r"><?= num($b['amount'], 6) ?></td></tr>
        <?php endforeach; ?>
      </table>
      <?php if (($status['mode'] ?? '') === 'live'): $st = $status['settings'] ?? []; ?>
        <p class="muted">
          累計ガス代: <?= num($status['gasSpentEth'] ?? 0, 6) ?> ETH ·
          直近24時間のリバランス: <?= h($status['rebalances24h'] ?? 0) ?> / <?= h($st['maxRebalancesPerDay'] ?? '-') ?> 回<br>
          運用上限: <?= num($st['maxDeployValue'] ?? null, 0) ?> <?= h($sym1) ?> ·
          レンジ幅: ±<?= h($st['rangeWidthPct'] ?? '-') ?>% ·
          スリッページ: <?= h($st['slippagePct'] ?? '-') ?>%
        </p>
      <?php endif; ?>
    </div>
    <div class="card">
      <h2>取引履歴</h2>
      <?php if (empty($status['history'])): ?>
        <p class="muted">まだ取引はありません。</p>
      <?php else: ?>
      <ul class="log">
        <?php $labels = ['open' => '新規作成', 'rebalance' => 'リバランス', 'exit' => '引き上げ']; ?>
        <?php foreach ($status['history'] as $e): ?>
          <li><span class="muted"><?= h(date('m/d H:i', strtotime($e['time']))) ?></span>
            <strong><?= h($labels[$e['type']] ?? $e['type']) ?></strong> <?= h($e['detail']) ?></li>
        <?php endforeach; ?>
      </ul>
      <?php endif; ?>
    </div>
  </section>

  <section class="grid2">
    <div class="card">
      <h2>ログ</h2>
      <ul class="log">
        <?php foreach ($status['events'] ?? [] as $e): ?>
          <li class="lv-<?= h($e['level']) ?>"><span class="muted"><?= h(date('m/d H:i', strtotime($e['time']))) ?></span> <?= h($e['message']) ?></li>
        <?php endforeach; ?>
      </ul>
    </div>
  </section>
</main>
</body>
</html>
