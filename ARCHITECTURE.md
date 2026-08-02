# Kiến trúc: Flow đa Agent cấu hình được

Tài liệu này mô tả mô hình dữ liệu và runtime để người dùng nghiệp vụ **tự dựng
luồng nhiều AI Agent** mà không sửa code — thay cho mô hình 5 stage cố định
hiện tại.

Nguồn tham chiếu: workflow n8n đang vận hành (95 node, 4 AI Agent, 3 LLM chain,
4 tool, 2 memory store).

---

## 1. Vì sao mô hình hiện tại không đủ

`studio.flow_versions.graph` hiện có `nodes[]` và `edges[]`, nhưng mỗi node chỉ
là `{ runtimeStage, promptCode }` với `runtimeStage` bị giới hạn trong 5 giá trị
hard-code (`ICE_BREAK`, `QUALIFICATION`, `QNA_COURSE`, `QNA_PRICE`, `HUMAN`).

Hệ quả — flow chỉ chọn được *prompt nào cho stage nào*. Không thể:

| Nhu cầu | Hiện tại |
|---|---|
| Thêm một agent mới (VD: "Tư vấn lộ trình") | Phải sửa `runtimeStages` trong `flow.ts` |
| Cho mỗi agent một bộ tool riêng | Tool là 3 chuỗi hard-code trong `requiredToolForStage()` |
| Nối agent này sang agent khác | `edges` chỉ để vẽ, runtime không đi theo |
| Rẽ nhánh theo điều kiện | Không có node điều kiện |
| Tiền xử lý ảnh trước khi vào agent | Không có |
| Hậu xử lý (viết lại giọng tự nhiên) | Không có |
| Agent có memory riêng | Không có |

n8n làm được tất cả những điều trên. Mục tiêu là đưa năng lực đó vào sản phẩm,
có thêm version và release mà n8n không có.

---

## 2. Ba lớp tách bạch

Điểm mấu chốt của thiết kế: **tách "cái gì" khỏi "khi nào"**.

```
  Lớp 1 — TÀI NGUYÊN     Agent, Tool, Knowledge Collection, Dataset, Model Profile
                          Mỗi thứ có code ổn định + nhiều version bất biến
                                        │  tham chiếu theo CODE
  Lớp 2 — FLOW            Đồ thị node + cạnh có điều kiện
                          Node trỏ tới tài nguyên bằng code, không nhúng nội dung
                                        │  pin theo VERSION
  Lớp 3 — RELEASE         Manifest chốt cứng version của mọi thứ ở trên
```

Nhờ vậy:
- Sửa prompt của một agent **không** phải sửa flow.
- Sửa flow **không** phải sửa agent.
- Release cũ vẫn chạy đúng nội dung cũ vì nó pin version.
- Rollback = đổi con trỏ release, không phải khôi phục từng bản ghi.

---

## 3. Kiểu node

Mỗi node có `type`, `id`, `label`, `config`. Runtime chọn executor theo `type`.

| Type | Nhiệm vụ | Config chính | Tương ứng n8n |
|---|---|---|---|
| `entry` | Điểm vào | — | Webhook |
| `preprocess` | Chuẩn hoá đầu vào: vision, OCR, bóc link | `steps[]` | Analyze image, Search Link |
| `guard` | Luật cứng chạy trước model | `ruleSetCode` | IfDoesNotExist, filter |
| `classifier` | Phân loại, trả JSON có schema | `agentCode`, `outputSchema` | kiểm duyệt trạng thái |
| `router` | Rẽ nhánh tất định theo biểu thức | `branches[]` | If, If1…If6 |
| `agent` | Gọi LLM có persona + tool + memory | `agentCode` | Ice Break, Qualification, Tra cứu… |
| `tool` | Gọi tool trực tiếp, không qua LLM | `toolCode`, `input` | Postgres, NocoDB |
| `transform` | Gộp / ánh xạ dữ liệu | `expression` | Merge, Set, Code |
| `handover` | Chuyển người thật | `reasonCode`, `priority` | InsertUserHandover |
| `respond` | Soạn kế hoạch gửi tin | `segmentation`, `typingIndicator` | Loop + SendTypingOn + Bắn Messenger |

Node `agent` là trung tâm. Nó **không** chứa prompt — chỉ trỏ `agentCode`.

### Cạnh có điều kiện

```jsonc
{ "id": "e1", "source": "classify", "target": "agent_pricing",
  "when": "stage == 'QNA_PRICE' && confidence >= 0.7" }
```

Biểu thức chạy trên một sandbox chỉ đọc, không phải `eval` — chỉ cho phép so
sánh, logic và truy cập trường của context. Cạnh không có `when` là nhánh mặc
định. Nhiều cạnh khớp thì lấy cạnh có `priority` nhỏ nhất.

---

## 4. Agent là tài nguyên độc lập

```
studio.agents            code, name, kind, status
studio.agent_versions    system_prompt, user_template, model_profile_code,
                         parameters, tool_codes[], knowledge_codes[],
                         memory (jsonb), output_schema (jsonb),
                         version_no, status
```

`kind` phân biệt cách runtime dùng agent:
- `conversational` — sinh câu trả lời cho khách (Ice Break, Qualification…)
- `classifier` — trả JSON theo `output_schema`, không gửi cho khách
- `rewriter` — viết lại đầu ra của agent khác (Basic LLM Chain1)
- `extractor` — bóc thông tin từ ảnh/tài liệu (Analyze image)

`memory` khai báo agent nhìn được bao nhiêu lịch sử:
```jsonc
{ "kind": "conversation_window", "maxTurns": 12, "scope": "conversation" }
```
Trong n8n, Ice Break + Qualification dùng chung một memory store, còn hai agent
tra cứu dùng store khác. Mô hình này diễn đạt được bằng `scope`.

---

## 5. Tool registry — hết hard-code

```
studio.tools           code, name, kind, status
studio.tool_versions   input_schema, output_schema, binding (jsonb),
                       zero_result_behaviour, timeout_ms, version_no, status
```

`kind` và `binding` tương ứng:

| kind | binding | Dùng cho |
|---|---|---|
| `structured_query` | `{ tableCode, filters[], columns[], limit, orderBy }` | Đọc bảng Structured Data |
| `knowledge_search` | `{ collectionCode, topK, minScore }` | RAG trên tài liệu |
| `pricing_quote` | `{ tableCode, asOfField, segmentField }` | Báo giá có hiệu lực |
| `http` | `{ method, url, headers, bodyTemplate, allowlist[] }` | Gọi API ngoài |

**Tool sinh ra từ bảng, không viết tay.** Người dùng tạo bảng ở Structured Data
rồi bấm "Tạo tool từ bảng này" — hệ thống sinh `input_schema` từ các cột được
chọn làm tham số, `output_schema` từ các cột trả về. Đây là câu trả lời cho yêu
cầu 5.8: tạo bảng mới là AI dùng được ngay, không cần sửa code.

`zero_result_behaviour` bắt buộc khai báo, không để runtime tự đoán:
`ask_clarifying` | `handover` | `return_empty`.

**AI không bao giờ sinh SQL.** Nó chỉ được gọi tool đã khai báo, với tham số
đúng `input_schema`, trên đúng bảng mà tool được phép đọc.

---

## 6. Dữ liệu có cấu trúc và phi cấu trúc

Đây là phần trả lời cho câu hỏi "thêm sửa xoá tiện mà thông tin vẫn thông suốt".

### Nguyên tắc chung

Cả hai loại dữ liệu đi theo cùng một vòng đời, nên người dùng chỉ phải học một
lần:

```
  Nháp  →  Kiểm tra  →  Publish  →  Đưa vào Release  →  Runtime đọc
   ↑                                                        │
   └──────────────── Rollback đổi con trỏ release ──────────┘
```

Runtime **chỉ đọc bản đã publish VÀ được release pin**. Sửa nháp không bao giờ
ảnh hưởng khách hàng đang chat.

### Dữ liệu có cấu trúc — nguồn sự thật cho số liệu

```
knowledge.tables            code, name, schema_definition, primary_key
knowledge.table_versions    schema snapshot, version_no, status
knowledge.records           table_id, data (jsonb), effective_from/to, status
```

Dùng cho: tên khoá, học phí, lịch khai giảng, địa điểm, chính sách trả góp.
Những thứ **không được phép bịa** thì phải đến từ đây, không đến từ RAG.

CRUD tiện vì: sửa một bản ghi là sửa một dòng, có validation theo schema, có
audit. Thông suốt vì: bản ghi có `effective_from/to` nên biết được tại thời
điểm nào giá nào đúng, và `dataset_version` cho phép release pin nguyên trạng.

### Dữ liệu phi cấu trúc — ngữ cảnh và diễn giải

```
knowledge.documents           title, source, owner, tags
knowledge.document_revisions  original_content, clean_content, status
knowledge.chunks              content, embedding, heading_path
knowledge.collections         code, name, embedding_profile, version, status
knowledge.collection_members  collection_id, document_revision_id
```

Dùng cho: mô tả khoá, quy trình, chính sách dài, kinh nghiệm bán hàng
(tương ứng tool `rcm2` trong n8n).

**Collection là đơn vị gán cho agent**, không phải từng tài liệu. Agent khai báo
`knowledge_codes: ["sales-playbook", "course-detail"]`. Thêm tài liệu vào
collection là agent dùng được ngay sau khi publish — không phải sửa agent.

### Chỗ nối hai loại

Một chunk phi cấu trúc có thể tham chiếu tới bản ghi có cấu trúc qua metadata:

```jsonc
{ "refs": [{ "table": "course-catalog", "recordKey": "DIGI-PERF" }] }
```

Khi agent trích dẫn chunk đó, runtime kèm luôn bản ghi cấu trúc tương ứng. Nhờ
vậy câu trả lời vừa có diễn giải (từ tài liệu) vừa có số liệu chính xác (từ
bảng), và trace chỉ rõ số tiền đến từ `record_id` nào.

Quy tắc bất di bất dịch: **số tiền, ngày, tên khoá luôn lấy từ bảng.** Tài liệu
chỉ bổ sung phần mô tả.

---

## 7. Runtime thực thi đồ thị

```
executeFlow(flowVersion, context) {
  node = flow.entryNode
  trace = []
  while (node) {
    result = executors[node.type](node, context, trace)
    context = merge(context, result)
    node = chooseNextNode(node, context)   // đánh giá `when` của các cạnh
    if (trace.length > flow.maxSteps) throw LoopGuard
  }
}
```

Ràng buộc bắt buộc:
- `maxSteps` chặn vòng lặp vô hạn (mặc định 25).
- Mỗi lượt node ghi một dòng trace: input, output, latency, token, chi phí.
- Node `agent` chỉ gọi được tool nằm trong `tool_codes` của chính nó — vi phạm
  là chặn, ghi `tool_permission_violation`.
- Toàn bộ lời gọi model nằm **ngoài** transaction DB (đã sửa ở đợt trước).

Việc thực thi đồ thị thay cho hàm `executeTurn()` tuyến tính hiện nay. Bản thân
`executeTurn()` trở thành một flow mặc định gồm: guard → classifier → router →
agent → respond, để hệ thống cũ vẫn chạy trong lúc chuyển đổi.

---

## 8. Release pin những gì

```jsonc
{
  "flowVersionId": "…",
  "agentVersionIds":   { "ice-break": "…", "qualification": "…" },
  "toolVersionIds":    { "course_lookup": "…", "pricing_quote": "…" },
  "collectionVersions":{ "sales-playbook": 4 },
  "datasetVersions":   { "course-catalog": 12, "pricing-rules": 7 },
  "modelProfiles":     { "conversation-primary": "…" },
  "embeddingProfile":  "openai-text-embedding-3-small-1536",
  "languagePolicy":    { "default": "vi", "mode": "follow_customer" },
  "guardrailVersion":  "…",
  "rendererPolicy":    { "maxSegments": 4, "typingIndicator": true }
}
```

Hiện release mới pin `flowVersionId` + `promptVersionIds`. Phần còn lại là việc
phải làm.

---

## 9. Lộ trình chuyển đổi

Không đập đi làm lại. Từng bước đều chạy được:

| Bước | Nội dung | Rủi ro |
|---|---|---|
| 1 | Thêm bảng `agents`, `agent_versions`, `tools`, `tool_versions` | Không, chỉ thêm bảng |
| 2 | Chuyển 5 prompt hiện có thành 5 agent tương đương | Thấp, dữ liệu ánh xạ 1-1 |
| 3 | Mở rộng schema `graph`, giữ tương thích ngược | Thấp, flow cũ vẫn parse được |
| 4 | Viết engine thực thi đồ thị, chạy song song engine cũ sau cờ bật/tắt | Trung bình |
| 5 | Sinh tool từ bảng Structured Data | Thấp |
| 6 | UI dựng flow bằng kéo thả | Không ảnh hưởng runtime |
| 7 | Bỏ engine cũ khi evaluation của cả hai khớp nhau | Có cổng kiểm soát |

Bước 1–3 không đổi hành vi runtime. Chỉ từ bước 4 mới cần evaluation đối chiếu
song song trước khi cắt.
