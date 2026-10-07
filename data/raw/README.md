# raw：原始数据

保存下载的原始资料，作为预处理输入。

- `ocnli/`：[OCNLI 官方仓库](https://github.com/CLUEbenchmark/OCNLI)的本地副本，保留官方 README、数据和参考代码。
- 实际读取 `ocnli/data/ocnli/train.3k.json` 和 `dev.json`；不同规模训练子集不拼接，`test.json` 不参与训练或验证。

预处理入口为 `scripts/prepare_ocnli.py`，输出写入 `data/processed/ocnli/`。原始仓库不纳入项目 Git。
