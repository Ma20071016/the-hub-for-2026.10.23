# ocnli：三分类训练与验证数据

保存 `scripts/prepare_ocnli.py` 生成的 UTF-8 JSONL。

- `train.jsonl`：2,993 条训练样本。
- `validation.jsonl`：2,950 条验证样本。

每条包含 `id / claim / evidence / label / source_id / source_locator / group_id`。文件保留英文标签，加载时转换为 `supports=0 / refutes=1 / insufficient=2`。

划分规则见[数据说明](../../../docs/data_preparation.md)，排除明细及哈希见[预处理报告](../../../reports/ocnli_preprocessing.json)。
