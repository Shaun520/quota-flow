-- 0029_add_zhipu_vidu_models.sql
-- 智谱（bigmodel）扩展视频模型：新增 Vidu Q1 / Vidu 2，并补全 cogvideox-3 的首尾帧模式。
-- Vidu Q1/Vidu 2 为统一模型，具体文生/图生/首尾帧/参考生模式在「生成模式」下拉选择，
-- 调度时由 api-branch 的 ZHIPU_API_MODEL 映射为实际 API 子模型（viduq1-*/vidu2-*）。
-- Idempotent：重复执行只更新 capabilities 字段，不重复插入。

UPDATE providers
SET capabilities = '{"models":[
  {"id":"cogvideox-flash","modes":["text2video","img2video"],"free":true,"price":"免费"},
  {"id":"cogvideox-2","modes":["text2video","img2video"],"free":false,"price":"¥0.5/次"},
  {"id":"cogvideox-3","modes":["text2video","img2video","first_last"],"free":false,"price":"¥1/次"},
  {"id":"Vidu Q1","modes":["text2video","img2video","first_last"],"free":false,"price":"¥2.5/次"},
  {"id":"Vidu 2","modes":["img2video","first_last","multi_ref"],"free":false,"price":"¥1.25/次起"}
]}'::jsonb
WHERE id = 'zhipu';