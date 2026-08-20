-- 0033_volcengine_lite_model_ids.sql
-- 修正火山方舟（volcengine）provider_caps 免费视频模型目录：lite 系列官方 Model ID 带 -250428 日期后缀
-- （doubao-seedance-1-0-lite-t2v-250428 / doubao-seedance-1-0-lite-i2v-250428），且 t2v/i2v 为两个独立 ID。
-- 与 spec.ts 的 MODELS.volcengine、providers/caps catalog 保持一致（厂商级 Catalog）。
-- provider_caps 语义、NULL target_id 幂等方式同 0032。

UPDATE public.provider_caps
SET models = ARRAY[
      'doubao-seedance-1-0-pro-250528',
      'doubao-seedance-1-5-pro-251215',
      'doubao-seedance-1-0-pro-fast-251015',
      'doubao-seedance-1-0-lite-t2v-250428',
      'doubao-seedance-1-0-lite-i2v-250428'
    ],
    updated_at = now()
WHERE target_type = 'global' AND target_id IS NULL AND provider = 'volcengine';