# ocnli_50k：当前训练数据

保存 `scripts/prepare_ocnli.py` 从 OCNLI `train.50k.json` 和 `dev.json` 生成的 UTF-8 JSONL，供 `scripts/model_data.py` 加载。

- `train.jsonl`：清洗并隔离同源分组后保留 37,072 条训练样本。
- `validation.jsonl`：2,950 条验证样本，保留官方 dev 的有效记录。

每条包含 `id / claim / evidence / label / source_id / source_locator / group_id`；标签映射为 `supports=0 / refutes=1 / insufficient=2`。`50k` 表示原始数据版本，实际训练数量以清洗结果为准。

规则见[数据说明](../../../docs/data_preparation.md)，排除明细与哈希见[预处理报告](../../../reports/ocnli_50k_preprocessing.json)。仅本说明纳入 Git，JSONL 留在本地。
