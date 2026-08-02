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

---

# Phần II — Đối chiếu với ba module mục tiêu

Viết sau khi có mô tả rõ kỳ vọng: **Document · Prompt · Flow đa Agent**, với
tinh thần xuyên suốt là *đội sale tự chủ động, không phải chờ một người*.

Phần I ở trên viết trước khi biết kỳ vọng này, nên **thiếu hẳn Module 2** và có
một quyết định thiết kế **đi ngược** Module 1. Mục này sửa lại.

## 10. Đánh giá trung thực hiện trạng

| Module | Đang có | Mức khớp | Chặn ở đâu |
|---|---|---|---|
| 1. Document | documents → revisions → chunks → collections, parse Tika, publish gate | **~40%** | Embedding giả · sale không có quyền · sửa không tự embed · release pin chặn nội dung |
| 2. Prompt | registry + version bất biến + publish | **~25%** | Vòng tự cải tiến **chưa tồn tại** · không có lịch định kỳ · không có tín hiệu "trả lời sai" |
| 3. Flow | thiết kế + schema bước 1–2 | **~30%** | Engine đồ thị chưa có · sale không có quyền · chưa có rào an toàn cho người không chuyên |

### 10.1. Lỗi chặn chung cho cả ba module: mô hình quyền

Vai trò `sales-agent` hiện có đúng 4 quyền: `dashboard.view`,
`conversation.read.team`, `conversation.reply.assigned`,
`conversation.takeover`.

Sale **không** có `knowledge.read`, `knowledge.write`, `studio.write`. Nghĩa là
toàn bộ tiền đề "sale tự thêm tài liệu / prompt / agent" hiện **bị chặn ngay ở
tầng quyền**. Hệ thống đang được thiết kế cho một quản trị viên duy nhất.

Đây là gốc rễ, phải sửa trước mọi thứ khác. Không sửa thì ba module dù làm xong
vẫn chỉ mình một người dùng được.

### 10.2. Module 1 — bốn vấn đề cụ thể

**a. Embedding là giả.** `localEmbedding()` băm SHA256 vào 64 chiều. Hai câu
cùng nghĩa khác từ vựng cho vector gần như trực giao. Nghĩa là **thêm tài liệu
vào cũng không giúp AI hiểu thêm** — nó chỉ khớp được khi trùng từ khoá. Đây là
lỗi chặn tuyệt đối của Module 1: mọi thứ khác làm xong mà cái này chưa sửa thì
module vẫn vô nghĩa.

**b. Sửa tài liệu không tự động embedding.** `queueDocumentIndex` chỉ chạy khi
chuyển trạng thái sang `approved`/`published`. Tạo revision mới bằng cách sửa
nội dung **không** kích hoạt index. Kỳ vọng là "sửa trong này sẽ tự động
embedding" — hiện chưa đúng.

**c. Sale không có quyền đọc/ghi tri thức.** Xem 10.1.

**d. Quyết định thiết kế của tôi đi ngược kỳ vọng.** Phần I viết Release pin
`collectionVersions`. Hệ quả: sale thêm tài liệu, publish xong, **bot vẫn chưa
biết** cho tới khi ai đó tạo và kích hoạt release mới. Trái thẳng với "thêm tài
liệu cho AI được luôn mà không cần đợi". Phải sửa — xem 11.

### 10.3. Module 2 — phần lõi hoàn toàn chưa tồn tại

Ý tưởng "AI hàng tuần rà hội thoại quá khứ, tự đề xuất nâng cấp prompt, người
chỉ duyệt" là phần **giá trị nhất** trong cả ba module, và hiện **không có gì**:

| Cần | Có chưa |
|---|---|
| Lịch chạy định kỳ | Không — `platform.jobs` không có trường cron/recurrence |
| Tín hiệu "AI trả lời sai" | Không — không có bảng feedback/annotation nào |
| Agent phân tích hội thoại hỏng | Không |
| Luồng đề xuất → duyệt → publish | Không |
| Bằng chứng kèm đề xuất | Không |

Phần I của tài liệu này cũng **không hề nhắc tới** — đó là thiếu sót của thiết
kế, không phải của hệ thống.

### 10.4. Module 3 — hướng đúng, thiếu rào an toàn

Thiết kế đồ thị ở Phần I đúng hướng. Nhưng nó ngầm giả định người dựng flow là
kỹ sư. Khi mở cho sale, xuất hiện rủi ro Phần I chưa xử lý: **một agent do
người không chuyên tạo ra có thể bịa giá, hứa suất học, xác nhận thanh toán.**

Cần rào chắn không tắt được — xem 13.

---

## 11. Sửa hướng: tách *tri thức* khỏi *hành vi*

Đây là điều chỉnh quan trọng nhất so với Phần I.

Hai loại thay đổi có rủi ro khác nhau, nên **không được đi chung một cổng**:

| | Tri thức (Module 1) | Hành vi (Module 2, 3) |
|---|---|---|
| Là gì | Bot **biết** gì | Bot **suy nghĩ** thế nào |
| Ví dụ | Tài liệu, bản ghi giá, lịch khai giảng | Prompt, agent, flow, rule, tool |
| Sai thì sao | Trả lời sai một sự việc | Sai toàn bộ cách hành xử |
| Cổng kiểm soát | **Publish là đủ** → tới bot ngay | **Phải qua Release** |
| Ai duyệt | Trưởng nhóm sale | Người có `release.manage` |
| Rollback | Về revision trước, tức thì | Đổi con trỏ release |

**Release pin *phạm vi* của collection, không pin *nội dung*.** Release nói
"agent tư vấn giá được đọc collection `sales-playbook`" — còn trong collection
đó hôm nay có bao nhiêu tài liệu là chuyện của Module 1. Thêm tài liệu vào
collection đã được cấp quyền thì tới bot ngay sau khi publish.

Điều này an toàn vì tài liệu **không thể** đổi hành vi bot:

- Guardrail chống bịa số vẫn chạy, không tắt được.
- Tiền, ngày, tên khoá vẫn **bắt buộc** lấy từ bảng có cấu trúc, không lấy từ
  tài liệu.
- Tài liệu chỉ được dùng cho phần diễn giải.

Trường hợp cần chặt hơn (hợp đồng, cam kết pháp lý) thì collection bật cờ
`pinned: true` để release đóng băng version — nhưng đó là ngoại lệ, không phải
mặc định.

### Vòng đời tài liệu sau khi sửa

```
Sale upload/sửa  →  tự động parse + chunk + EMBED ngay  →  xem thử + test truy hồi
                 →  publish (trưởng nhóm duyệt)  →  bot dùng được ngay
```

Embedding chạy **khi lưu**, không đợi publish — để người viết thấy ngay tài
liệu của mình được truy hồi ra sao. Nhưng runtime vẫn chỉ đọc bản `published`.
Hai việc này độc lập: embed sớm để thử, publish để phát hành.

---

## 12. Module 2 — Vòng tự cải tiến prompt

```
   Lịch tuần
       |
       v
  Thu tín hiệu 7 ngày qua
   - handover ngoài ý muốn (COURSE_NOT_FOUND, PRICING_DATA_MISSING, LOW_CONFIDENCE)
   - guardrail bắt lỗi (invented_fact, missing_fact)
   - model fallback
   - nhân viên takeover rồi viết lại câu trả lời   <-- tín hiệu mạnh nhất
   - báo cáo "AI trả lời sai" từ Test Workspace
       |
       v
  Gom theo chủ đề (agent kind='analyst')
       |
       v
  Với mỗi chủ đề: agent kind='improver' đọc
  prompt hiện tại + các trace hỏng -> soạn version mới + lý do + trace dẫn chứng
       |
       v
  Tạo prompt_version status='draft', proposed_by='ai'
       |
       v
  BẮT BUỘC chạy evaluation suite --- trượt ---> tự loại, ghi lý do
       | đạt
       v
  Người xem: diff - dẫn chứng - kết quả eval  ->  Duyệt / Từ chối / Sửa rồi duyệt
       | duyệt
       v
  published  ->  đưa vào release  ->  runtime
```

Nguyên tắc bắt buộc:

- **AI không bao giờ tự publish.** Nó chỉ tạo được `draft`.
- **Đề xuất không có dẫn chứng thì không hiển thị.** Mỗi đề xuất phải kèm
  `ai_run_id` cụ thể để người duyệt bấm vào xem đúng cuộc hội thoại nào hỏng.
- **Không đạt evaluation thì không lên bàn duyệt**, tránh làm loãng sự chú ý.
- Người duyệt thấy **diff** so với bản đang chạy, không phải đọc lại từ đầu.

Cần bổ sung: `platform.schedules`, `platform.response_feedback`,
`studio.improvement_proposals`, và agent `kind` mới: `analyst`, `improver`.

---

## 13. Module 3 — Rào an toàn khi mở cho người không chuyên

Sale được tự thêm agent, nhưng trong khung có sẵn:

1. **Template agent**, không dựng từ trang trắng. Mỗi template đã gắn sẵn tool
   đúng và guardrail phù hợp (ví dụ "Tư vấn khoá học" đã có `course_lookup`).
2. **Guardrail cấp hệ thống không tắt được**: không bịa số, không xác nhận
   thanh toán, không hứa suất học, tiền/ngày luôn từ bảng.
3. **Tool phải được cấp**, agent mới mặc định không có tool nào. Cấp tool ngoài
   phạm vi cần quyền cao hơn.
4. **Bắt buộc chạy thử trong Test Workspace** trước khi được đề nghị publish.
5. **Publish agent = thay đổi hành vi → phải qua Release** (khác tài liệu).
6. Mọi thay đổi có audit và rollback.

Tóm lại: **tài liệu tự do hơn, hành vi chặt hơn.**

---

## 14. Thứ tự làm lại theo đúng ba module

Sắp lại so với Phần I, ưu tiên theo chỗ đang chặn:

| # | Việc | Mở khoá cho | Vì sao trước |
|---|---|---|---|
| 1 | Vai trò + quyền cho self-service | Cả 3 module | Không có thì không ai ngoài admin dùng được |
| 2 | Embedding thật (OpenAI 1536 chiều) | Module 1 | Chưa có thì thêm tài liệu vô nghĩa |
| 3 | Tự embed khi lưu + xem chunk + test truy hồi | Module 1 | Hoàn tất vòng đời tài liệu |
| 4 | Release pin phạm vi thay vì nội dung | Module 1 | Bỏ nút thắt "phải đợi release" |
| 5 | Bảng feedback + nút "AI trả lời sai" | Module 2 | Không có tín hiệu thì không cải tiến được |
| 6 | Bộ lập lịch định kỳ | Module 2 | Nền cho job hàng tuần |
| 7 | Agent analyst + improver + luồng duyệt | Module 2 | Phần lõi của module |
| 8 | Engine thực thi đồ thị | Module 3 | Phần lõi của module |
| 9 | Template agent + rào an toàn | Module 3 | Điều kiện để mở cho sale |
| 10 | UI dựng flow kéo thả | Module 3 | Sau cùng, không ảnh hưởng runtime |

Bước 1–2 là hai nút thắt lớn nhất. Làm xong hai bước đó thì Module 1 chạy được
thật, và cả ba module mới có nền để mở cho đội sale.

---

# Phần III — Kiến trúc thông tin và kế hoạch tới production

Viết sau khi có 9 màn thiết kế kỳ vọng. Chúng cho thấy khoảng cách lớn nhất
không nằm ở tính năng mà ở **kiến trúc thông tin**: hệ thống đang bày ra bảng
dữ liệu, không bày ra công việc người dùng cần làm.

## 15. Đơn giản hoá điều hướng

| Trước | Sau |
|---|---|
| 13 mục, 5 nhóm, tiếng Anh | **9 mục phẳng, tiếng Việt** |

```
Tổng quan · Hộp thư test · Tài liệu · Prompt · Luồng Agent
Dữ liệu · Đánh giá · Release · Cài đặt
```

Gộp lại:

| Mục cũ | Về đâu | Lý do |
|---|---|---|
| Conversations + Handover Cases + Customers | **Hộp thư test** | Cùng một việc: xem và can thiệp hội thoại |
| Prompts + Rules | **Prompt** | Rule là một loại ràng buộc của prompt, không phải module riêng |
| Conversation Flow | **Luồng Agent** | Đúng tên gọi sản phẩm |
| Structured Data | **Dữ liệu** | Ngắn, người nghiệp vụ hiểu ngay |
| Integrations + Jobs & Runtime | **Cài đặt** | Việc quản trị, không phải việc hằng ngày |

Bỏ tiêu đề nhóm (OVERVIEW/OPERATIONS/…). Với 9 mục thì nhóm chỉ tốn chiều cao
và thêm một tầng phải đọc.

## 16. Đặc tả từng màn theo thiết kế

### 16.1. Tài liệu — thư viện

Cột: Tài liệu · Nguồn · Loại · Revision · **Chunks** · Trạng thái · Cập nhật.
Bốn thẻ số: Tổng · Đang review · Đã publish · **Cần re-embed**.
Panel phải: **Nguồn tri thức đang dùng** (collection + số tài liệu + trạng thái
embed) và vùng kéo thả file.

Điểm quan trọng: cột `Chunks` và thẻ `Cần re-embed` biến embedding từ thứ vô
hình thành thứ người dùng thấy và kiểm soát được.

### 16.2. Tài liệu — review trước embedding

Ba cột: cây heading · trình soạn thảo · nhận xét.
Panel phải: **Thiết lập embedding** (chunk profile, collection, tags, hiệu lực
từ ngày) · **Checklist trước publish** · ước tính token.

Đây là màn giải quyết đúng vấn đề "tài liệu crawl về phân mảnh, chưa thống
nhất": sửa sạch trước khi cho AI đọc.

### 16.3. Tài liệu — chunk preview và retrieval test

Trái: danh sách chunk có `Selected` / `Needs split`.
Giữa: chạy thử câu hỏi, xem Top 5 kết quả kèm điểm và đoạn trích.
Phải: lịch sử test + **cảnh báo chất lượng** (chunk điểm thấp, quá dài, trùng lặp).

Chỉ số: Recall@5 · điểm trung bình · tỷ lệ trùng lặp · token sử dụng.
Không có màn này thì người thêm tài liệu không biết mình làm tốt hay không.

### 16.4. Prompt — thư viện và chỉnh sửa

Thư viện: bảng prompt + panel **Prompt bundle đang dùng** (release nào đang
chạy version nào).
Chỉnh sửa: tab Hệ thống / User template / Allowed tools / Variables ·
timeline version · **Test nhanh so sánh Draft với Active cạnh nhau** · diff.

So sánh cạnh nhau là điểm mấu chốt: người sửa prompt thấy ngay mình làm tốt
hơn hay tệ đi.

### 16.5. Prompt — đề xuất tối ưu (Module 2)

Bảng case: Chủ đề · Phát hiện · Prompt liên quan · Mức độ ảnh hưởng · Trạng thái.
Chi tiết 6 bước: Hội thoại gốc → Phản hồi hiện tại → Phân tích vấn đề →
**Đề xuất patch** → Cải thiện kỳ vọng → Hành động (Duyệt / Sửa thêm / Từ chối).
Panel phải: số case đã phân tích · đề xuất ưu tiên cao · tỷ lệ duyệt · tác động ước tính.

Ghi rõ trên giao diện: *AI chỉ đề xuất, con người duyệt trước khi áp dụng.*

### 16.6. Luồng Agent — chi tiết agent

Cấu hình theo khối: Mô tả vai trò · System instruction · **Điều kiện kích hoạt**
· **Công cụ được phép** · **Liên kết dataset bắt buộc** · **Quy tắc chuyển tuyến**
· Schema đầu ra · **Guardrails** · Model.
Panel phải: test nhanh + hiệu suất 7 ngày.

"Liên kết dataset bắt buộc" chính là cơ chế ép số liệu đến từ bảng, không từ
suy đoán.

### 16.7. Luồng Agent — trình xây luồng

Canvas kéo thả. Palette: Inbox · Agent · Điều kiện · Hành động · Human Handoff ·
Kết thúc. Panel phải là thuộc tính node. Có **Validate flow** trước Publish.

### 16.8. Hộp thư test — mô phỏng và trace

Trái: khung chat. Phải: **trace từng bước đánh số** — mỗi bước ghi agent/tool
kèm version, trạng thái, độ trễ, thông tin chính. Bước tool bung ra Input /
Output / bản ghi đã chọn.
Dưới: trạng thái · quyết định chuyển giao · model · tool · release đang chạy.
Hành động: Chạy lại · So sánh release · Lưu thành test case.

Đây là màn quan trọng nhất để gỡ lỗi. Bảng `platform.ai_run_steps` (migration
016) sinh ra chính là để phục vụ màn này.

## 17. Những thứ thừa cần bỏ

| Thứ | Vì sao thừa | Xử lý |
|---|---|---|
| 5 runtime stage cứng | Đồ thị agent thay thế hoàn toàn | Bỏ sau khi engine chạy |
| `studio.prompts` / `prompt_versions` | Đã có `agents` / `agent_versions` | Gộp, giữ view tương thích |
| `renderer.ts` template tất định | Agent sinh câu trả lời, không phải template | Chỉ giữ cho fallback |
| `requiredToolForStage()` | Tool cấp ở agent | Bỏ |
| `studio.datasets` / `dataset_versions` | Chưa bao giờ dùng, trùng `knowledge.tables` | Bỏ hoặc gộp |
| `004_english_workspace_content.sql` | Chuyển seed sang tiếng Anh, ngược hướng | Migration mới ghi đè về tiếng Việt |
| Hai lớp CSS trong `globals.css` | Lớp sau ghi đè lớp trước, đã lừa tôi 2 lần | Gộp một lớp |
| Trang Rules riêng | Là ràng buộc của prompt | Nhập vào màn Prompt |
| Trang Customers riêng | Ít dùng, thuộc hội thoại | Nhập vào Hộp thư test |
| Trang Jobs riêng | Việc quản trị | Nhập vào Cài đặt |

## 18. Chuẩn production — không phải MVP

Khác biệt giữa MVP và production nằm ở những thứ dưới đây, không ở tính năng:

**Đúng đắn**
- Embedding thật, có version, re-embed được, đo được chất lượng truy hồi
- Số liệu luôn từ bảng có cấu trúc, có `effective_from/to`, truy nguyên tới record
- Guardrail không tắt được, có test hồi quy chặn release

**Vận hành**
- Health check đủ thành phần · worker heartbeat · restart policy *(xong)*
- Job có retry, backoff, dead letter *(xong)* + scheduler định kỳ *(xong schema)*
- Không gửi nhầm ra Meta ở môi trường test *(xong)*
- Backup và khôi phục database — **chưa có**
- Giới hạn tần suất đăng nhập và webhook — **chưa có**
- Log có correlation ID xuyên suốt *(xong)*
- Cảnh báo khi hàng đợi tắc, khi tỷ lệ fallback tăng — **chưa có**

**An toàn**
- Secret không nằm trong repo *(xong)*
- Production không khởi động khi thiếu secret *(xong)*
- Phân quyền theo vai trò *(xong schema, chưa áp vào UI)*
- Phiên đăng nhập thu hồi được — **chưa có**, JWT hiện không revoke được
- Audit đầy đủ *(xong)*

**Chất lượng**
- Evaluation chạy trên pipeline thật *(xong)*
- Bộ test case đủ 52 kịch bản — **chưa có**
- Đo được mức độ hoàn thiện UI *(xong, `ui-review`)*

## 19. Kế hoạch đầy đủ tới production

Mỗi giai đoạn kết thúc là hệ thống vẫn chạy được, không có bước nào để dở dang.

### Giai đoạn A — Tri thức thật sự hoạt động

| # | Việc | Kết quả kiểm chứng |
|---|---|---|
| A1 | Embedding provider + OpenAI 1536 chiều + migration đổi vector dim | Hai câu đồng nghĩa khác từ vựng cùng truy ra một chunk |
| A2 | Tự embed khi lưu, không đợi publish | Sửa tài liệu xong thấy chunk mới ngay |
| A3 | Màn chunk preview + retrieval test + cảnh báo chất lượng | Recall@5 hiển thị được |
| A4 | Re-embed toàn collection, có tiến độ | Đổi model không mất index đang chạy |
| A5 | Release pin phạm vi thay vì nội dung | Sale publish tài liệu là bot dùng ngay |

### Giai đoạn B — Prompt tự chủ và tự cải tiến

| # | Việc | Kết quả kiểm chứng |
|---|---|---|
| B1 | Gộp prompt vào agent, bỏ bảng trùng | Một nơi duy nhất để sửa |
| B2 | Màn sửa prompt: tab, diff, test Draft cạnh Active | So sánh được trước khi publish |
| B3 | Bảng feedback + nút "AI trả lời sai" trên trace | Có tín hiệu để học |
| B4 | Scheduler chạy cron trong worker | Job tuần chạy đúng giờ |
| B5 | Agent analyst gom chủ đề từ tín hiệu 7 ngày | Ra được danh sách case |
| B6 | Agent improver soạn patch + dẫn chứng | Đề xuất kèm `ai_run_id` |
| B7 | Bắt buộc qua evaluation trước khi lên bàn duyệt | Đề xuất trượt tự loại |
| B8 | Màn duyệt đề xuất 6 bước | Duyệt/từ chối trong một màn |

### Giai đoạn C — Luồng đa Agent

| # | Việc | Kết quả kiểm chứng |
|---|---|---|
| C1 | Engine thực thi đồ thị + ghi `ai_run_steps` | Chạy song song engine cũ, kết quả khớp |
| C2 | Node preprocess: vision cho ảnh, bóc link | Ảnh biên lai chuyển human đúng |
| C3 | Node router có điều kiện + loop guard | Rẽ nhánh đúng như n8n |
| C4 | Memory theo scope cho từng agent | Agent nhớ đúng phạm vi |
| C5 | Sinh tool từ bảng Dữ liệu | Tạo bảng xong AI dùng được ngay |
| C6 | Màn chi tiết agent theo thiết kế | Cấu hình đủ 9 khối |
| C7 | Canvas kéo thả + Validate flow | Sale tự dựng được luồng |
| C8 | Template agent + guardrail không tắt được | Người không chuyên dùng an toàn |
| C9 | Bỏ engine cũ và 5 stage cứng | Evaluation hai engine khớp |

### Giai đoạn D — Sẵn sàng vận hành

| # | Việc |
|---|---|
| D1 | Việt hoá toàn bộ 14 màn, gộp hai lớp CSS |
| D2 | Màn trace theo thiết kế (bước đánh số, bung input/output) |
| D3 | Áp phân quyền vào UI: ẩn thứ vai trò không được dùng |
| D4 | Thu hồi phiên đăng nhập, giới hạn tần suất |
| D5 | Backup + khôi phục database, thử khôi phục thật |
| D6 | Cảnh báo hàng đợi tắc, tỷ lệ fallback tăng |
| D7 | Bộ 52 test case của tài liệu nghiệp vụ |
| D8 | Nối n8n bridge chế độ shadow, so sánh kết quả |
| D9 | Nối Meta thật sau khi shadow ổn định |

Thứ tự bắt buộc: **A1 trước tất cả.** Chưa có embedding thật thì Module 1 vô
nghĩa, mà Module 2 và 3 đều phải đứng trên tri thức đúng.
