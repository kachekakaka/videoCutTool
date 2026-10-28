# 0007. 画面处理的配置归属与原生滤镜选型

> 状态：有效。2026-10-29 收窄为配置归属、坐标顺序与滤镜选型；当前界面与编码规则由架构文档维护。

## Context

用户需要调整画幅、去除静态台标或遮挡局部内容；黑边与台标通常跨越多个片段，也有个别片段需要不同处理。引入大型 AI 模型及独立运行环境会增加便携发行和维护成本。

## Decision

- 采用[全局配置与单段覆盖](../../CONTEXT.md#spatial-scope)，减少重复配置并保留局部差异。切点变化时由 [RetentionDraft](../../src/shared/RetentionDraft.ts)维护归属，避免界面按变化后的片段序号错配配置。
- 使用 FFmpeg 原生滤镜处理静态区域，避免新增 AI 运行环境。遮罩在原片坐标定位，先处理区域再裁切，防止移动裁切框带动遮罩漂移。滤镜实现见 [spatialFiltergraph](../../src/shared/spatialFiltergraph.ts)。
- 同一输出文件的不同尺寸片段通过 [Letterbox Normalization](../../CONTEXT.md#letterbox-normalization)统一画布，以填充黑边的代价保留画面比例；独立输出无需为其他片段统一尺寸。分组语义见 [Output File Group](../../CONTEXT.md#output-file-group)。

## Consequences

原生区域修补依赖周边像素，不能承诺恢复被遮挡的真实内容或跟踪任意运动目标。修改滤镜或输出组合时，仍需核对分段差异和配置归属。

早期统一强制智能降码的描述已由当前[导出模式](../架构.md#导出模式)规则替代；视图组织见[界面边界](../架构.md#界面与范围边界)，发行取舍见 [ADR 0002](0002-portable-distribution-and-user-data-setup.md)。
