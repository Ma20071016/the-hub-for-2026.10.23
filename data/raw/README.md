# 原始数据

`ocnli/` 保存 [OCNLI 官方仓库](https://github.com/CLUEbenchmark/OCNLI)的本地副本。当前预处理读取 `ocnli/data/ocnli/train.50k.json` 和 `dev.json`，不同规模训练集不拼接，`test.json` 不参与训练或验证。

在项目根目录运行：

```bash
git clone https://github.com/CLUEbenchmark/OCNLI.git data/raw/ocnli
git -C data/raw/ocnli checkout b53efdee17257a5c33993cf6fcf8ffff0497ea0e
python -m scripts.prepare_ocnli
```

已有本地仓库时跳过克隆，并确认使用上述历史实验版本。结果写入 `data/processed/ocnli_50k/`，统计与哈希写入 `reports/ocnli_50k_preprocessing.json`。本目录仅 README 纳入 Git；完整规则见[数据处理说明](../../docs/data_preparation.md)。
