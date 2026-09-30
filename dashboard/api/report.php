<?php
// Bot から状態を受け取り、管理画面の操作（一時停止など）を返す
declare(strict_types=1);
require __DIR__ . '/../lib.php';

header('Content-Type: application/json; charset=utf-8');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    exit('{"error":"method not allowed"}');
}

$token = (string)($_SERVER['HTTP_X_BOT_TOKEN'] ?? '');
if (!hash_equals((string)cfg()['bot_token'], $token)) {
    http_response_code(403);
    exit('{"error":"forbidden"}');
}

$raw = (string)file_get_contents('php://input');
if (strlen($raw) > 512 * 1024) {
    http_response_code(413);
    exit('{"error":"too large"}');
}
$body = json_decode($raw, true);
if (!is_array($body)) {
    http_response_code(400);
    exit('{"error":"invalid json"}');
}

$body['received_at'] = time();
write_json('status', $body);

echo json_encode(['control' => read_json('control', ['paused' => false])]);
