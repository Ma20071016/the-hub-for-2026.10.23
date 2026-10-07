# 诊断配置

保存可调整的脚本运行参数。

- [bert_encoder.json](bert_encoder.json)：BERT 诊断的资源报告路径、设备、batch 大小、最大长度、种子、CPU 线程数和报告输出路径。

此配置仅由 [check_bert_encoder.py](../scripts/check_bert_encoder.py) 读取，不控制完整模型结构或训练。
