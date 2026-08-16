-- 0024_creation_videos.sql
-- 桌面端创作中心「视频灵感库」：由 Admin 运营管理，普通登录用户只读 enabled=true。

CREATE TABLE IF NOT EXISTS public.creation_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  cover_url text NOT NULL,
  video_url text,
  duration_sec integer NOT NULL DEFAULT 5,
  category text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  prompt text NOT NULL,
  provider_hint text,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creation_videos_category
  ON public.creation_videos (category);

CREATE INDEX IF NOT EXISTS idx_creation_videos_enabled
  ON public.creation_videos (enabled);

CREATE INDEX IF NOT EXISTS idx_creation_videos_sort_order
  ON public.creation_videos (sort_order);

CREATE INDEX IF NOT EXISTS idx_creation_videos_updated_at
  ON public.creation_videos (updated_at DESC);

COMMENT ON TABLE public.creation_videos IS
  '创作中心视频灵感库：管理员维护的优秀视频案例、参考提示词与分类。';

ALTER TABLE public.creation_videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "creation_videos_select_enabled" ON public.creation_videos;
CREATE POLICY "creation_videos_select_enabled"
  ON public.creation_videos
  FOR SELECT
  TO authenticated
  USING (enabled = true);

DROP POLICY IF EXISTS "creation_videos_admin_all" ON public.creation_videos;
CREATE POLICY "creation_videos_admin_all"
  ON public.creation_videos
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

GRANT ALL ON TABLE public.creation_videos TO authenticated;

ALTER TABLE public.creation_videos REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'creation_videos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.creation_videos;
  END IF;
END $$;

-- 桌面端第一版本地样例一次性 seed；ON CONFLICT 避免覆盖后续管理端修改。
INSERT INTO public.creation_videos (
  id,
  title,
  cover_url,
  video_url,
  duration_sec,
  category,
  tags,
  prompt,
  provider_hint,
  enabled,
  sort_order
)
VALUES
  (
    '00000000-0000-0000-0000-000000000001',
    '雪后山巅少年剑客',
    'https://images.unsplash.com/photo-1533106418989-88406c7cc8ca?auto=format&fit=crop&w=640&q=80',
    NULL,
    10,
    '国漫3D风',
    ARRAY['国漫3D', '雪山', '云海'],
    '高规格国漫3D风格，少年剑客站在雪后山巅，衣摆随风翻飞，远处云海翻涌，镜头从正面缓慢推进，金色晨光穿透云层照亮剑锋。',
    '豆包 · Seedance 2.0 Mini',
    true,
    10
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    '雨夜霓虹巷战',
    'https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=640&q=80',
    NULL,
    5,
    '动作打斗',
    ARRAY['打斗', '雨夜', '慢镜头'],
    '高速动作打斗，雨夜巷战，两道人影在霓虹灯光下贴身交锋，慢镜头捕捉拳脚与雨滴碰撞，镜头快速切换，压迫感强。',
    '可灵 · 标准',
    true,
    20
  ),
  (
    '00000000-0000-0000-0000-000000000003',
    '霓虹雨幕天桥',
    'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=640&q=80',
    NULL,
    10,
    '赛博都市',
    ARRAY['赛博朋克', '城市夜景', '全息广告'],
    '赛博都市夜景，巨型全息广告在雨幕中闪烁，主角撑伞穿过拥挤天桥，霓虹色彩反射在积水路面，航拍缓慢拉升。',
    '豆包 · Seedance 2.0 Mini',
    true,
    30
  ),
  (
    '00000000-0000-0000-0000-000000000004',
    '白衣仙人御剑过云海',
    'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=80',
    NULL,
    5,
    '古风仙侠',
    ARRAY['仙侠', '御剑', '云海'],
    '古风仙侠意境，白衣仙人御剑飞过云海，衣袂飘动，瀑布从青翠山崖倾泻，镜头围绕仙人环绕半周。',
    '千问 · 万相',
    true,
    40
  ),
  (
    '00000000-0000-0000-0000-000000000005',
    '午后窗台的小猫',
    'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=640&q=80',
    NULL,
    5,
    '治愈系',
    ARRAY['治愈', '猫咪', '阳光'],
    '治愈系田园短片，小猫在午后窗台伸懒腰，阳光洒进房间，窗帘随风轻摆，镜头缓慢靠近猫爪，画面温暖柔光。',
    '海螺 · 标准',
    true,
    50
  ),
  (
    '00000000-0000-0000-0000-000000000006',
    '黄昏停机坪的机甲少女',
    'https://images.unsplash.com/photo-1528459801416-a9e53bbf4e17?auto=format&fit=crop&w=640&q=80',
    NULL,
    10,
    '国漫3D风',
    ARRAY['国漫3D', '机甲', '黄昏'],
    '国漫3D风战斗前奏，少女机甲在黄昏停机坪单膝落地，装甲表面亮起蓝色能量纹路，镜头低角度环绕展示细节。',
    '豆包 · Seedance 2.0 Mini',
    true,
    60
  ),
  (
    '00000000-0000-0000-0000-000000000007',
    '悬浮载具追车',
    'https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=640&q=80',
    NULL,
    10,
    '赛博都市',
    ARRAY['追车', '悬浮载具', '光轨'],
    '科幻城市追车戏，悬浮载具贴着高架桥高速穿行，车灯拖出光轨，镜头跟拍并切换俯冲视角，城市灯火快速掠过。',
    '可灵 · 大师',
    true,
    70
  ),
  (
    '00000000-0000-0000-0000-000000000008',
    '竹林红袖剑气',
    'https://images.unsplash.com/photo-1541701494587-cb58502866ab?auto=format&fit=crop&w=640&q=80',
    NULL,
    5,
    '古风仙侠',
    ARRAY['古风', '剑气', '竹海'],
    '古风仙侠，林间竹海起雾，女子红袖掠过竹叶，剑气切开雾气，镜头跟随红色衣袂穿行，风起叶落。',
    '千问 · 万相',
    true,
    80
  ),
  (
    '00000000-0000-0000-0000-000000000009',
    '雨天咖啡馆窗边',
    'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=640&q=80',
    NULL,
    5,
    '治愈系',
    ARRAY['治愈', '咖啡馆', '雨天'],
    '治愈系动画，雨天咖啡馆窗边，热咖啡升起白雾，小猫趴在桌角看雨滴滑落，镜头缓慢推近，色调温柔安静。',
    '海螺 · 标准',
    true,
    90
  )
ON CONFLICT (id) DO NOTHING;
