-- 0032_provider_caps_volcengine.sql
-- 火山方舟（volcengine）「生成能力」全局登记：把「绑定即抓模型」抓取到的免费视频模型
-- 关联到 provider_caps（global 作用域），使调度台 / Dashboard 把火山方舟限定为这组免费模型与模式。
-- 模型清单为平台固定值（2026-08-19 实测，见 docs/厂商与API平台接入/火山方舟免费视频模型额度对接.md），
-- 与 spec.ts 的 MODELS.volcengine、providers.capabilities.models 三者保持一致（厂商级 Catalog）。
-- provider_caps 语义：global 行存在即作为该 provider 的唯一可选项，空数组=屏蔽；此处给出免费模型白名单。
-- 注意 target_id 为 NULL：Postgres UNIQUE 对 NULL 各自独立，不能依赖 ON CONFLICT 幂等，故用 存在则更 / 否则插。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.provider_caps
    WHERE target_type = 'global' AND target_id IS NULL AND provider = 'volcengine'
  ) THEN
    UPDATE public.provider_caps
    SET modes = ARRAY['text2video','img2video'],
        models = ARRAY['doubao-seedance-1-0-pro-250528','doubao-seedance-1-5-pro-251215','doubao-seedance-1-0-pro-fast-251015','doubao-seedance-1-0-lite-t2v','doubao-seedance-1-0-lite-i2v'],
        updated_at = now()
    WHERE target_type = 'global' AND target_id IS NULL AND provider = 'volcengine';
  ELSE
    INSERT INTO public.provider_caps (target_type, target_id, provider, modes, models)
    VALUES (
      'global', NULL, 'volcengine',
      ARRAY['text2video','img2video'],
      ARRAY['doubao-seedance-1-0-pro-250528','doubao-seedance-1-5-pro-251215','doubao-seedance-1-0-pro-fast-251015','doubao-seedance-1-0-lite-t2v','doubao-seedance-1-0-lite-i2v']
    );
  END IF;
END $$;