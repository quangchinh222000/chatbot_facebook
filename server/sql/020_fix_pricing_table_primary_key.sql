-- Bảng Pricing Rules khai báo primaryKey là "id" nhưng danh sách columns không
-- có cột nào key="id". Validation của registry đòi primaryKey phải trỏ tới một
-- cột đã định nghĩa, nên API records trả 400 và giao diện không hiện được dòng
-- nào — dù sidebar vẫn đếm đúng 59 bản ghi.
--
-- Thêm cột id vào định nghĩa. Adapter pricing_rules vốn đã trả p.id nên không
-- cần đổi gì ở tầng đọc dữ liệu.
UPDATE structured.tables
SET schema_definition = jsonb_set(
      schema_definition,
      '{columns}',
      '[{"key":"id","label":"ID","type":"text","required":true}]'::jsonb || (schema_definition -> 'columns')
    )
WHERE code = 'pricing-rules'
  AND NOT (schema_definition -> 'columns' @> '[{"key":"id"}]'::jsonb);
