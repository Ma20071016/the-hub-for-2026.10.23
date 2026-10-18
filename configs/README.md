# 诊断配置

当前只有 [bert_encoder.json](bert_encoder.json)，配置 BERT 诊断所用资源、设备、batch 大小、最大长度、随机种子、CPU 线程数和报告输出路径。默认使用 CUDA。

在项目根目录运行：

```bash
python -m scripts.check_bert_encoder --config configs/bert_encoder.json
```

此配置仅由 [check_bert_encoder.py](../scripts/check_bert_encoder.py) 读取，不控制完整模型结构或训练。
