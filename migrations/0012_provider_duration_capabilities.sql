-- 0012_provider_duration_capabilities.sql
-- 厂商时长能力以 providers.capabilities.supported_durations 为准。
-- 当前实际执行链路只确认豆包支持 5s / 10s；未确认支持 15s 的一律不配置 15。

UPDATE providers
SET capabilities = COALESCE(capabilities, '{}'::jsonb) || '{"supported_durations":[5,10]}'::jsonb
WHERE id IN ('doubao', 'jimeng', 'qwen', 'qwenwan', 'hailuo', 'mathmind');

UPDATE providers
SET capabilities = COALESCE(capabilities, '{}'::jsonb) || '{"supported_durations":[5]}'::jsonb
WHERE id IN ('yuanbao', 'kling');
