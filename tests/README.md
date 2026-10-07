# tests

基于标准库 `unittest` 的自动化检查。

- [test_bert_encoder.py](test_bert_encoder.py)：9 项冻结双路 BERT 测试，覆盖共享编码、形状、mask、冻结状态、下游梯度、异常输入及本地权重保存加载。

使用随机初始化的小型 BERT，在 CPU 上运行，无需下载权重。当前测试范围仅为编码器。

在项目根目录、已配置依赖的环境中运行：

```bash
python -B -m unittest discover -s tests
```
