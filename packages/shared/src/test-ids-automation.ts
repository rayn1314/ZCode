// 定时任务（automation）与闲时任务（off-peak）及其调度 builder 的测试 id。
// test-ids.ts 已顶到 oxlint max-lines 上限（400 行），这一族整段拆出；
// 仍从 @zcode/shared 桶文件导出，消费方 import 路径不变。

export const TID_AUTOMATIONS_OPEN = "automations-open";
export const TID_AUTOMATIONS_LIST = "automations-list";
/** 定时 / 闲时列表共用的状态筛选胶囊行（全部 / 进行中 / 已完成 / 失败） */
export const TID_AUTOMATIONS_STATUS_FILTER = "automations-status-filter";
export const TID_AUTOMATION_CREATE_MENU = "automation-create-menu";
export const TID_AUTOMATION_CREATE_MANUALLY = "automation-create-manually";
export const TID_AUTOMATION_CARD = "automation-card";
// 闲时任务（off-peak，独立面）
export const TID_OFFPEAK_CREATE_BUTTON = "offpeak-create-button";
export const TID_OFFPEAK_CARD = "offpeak-card";
/** 闲时卡片脚注：绑定会话标题（会话内创建）。 */
export const TID_OFFPEAK_CARD_SESSION = "offpeak-card-session";
export const TID_OFFPEAK_CARD_MENU = "offpeak-card-menu";
export const TID_OFFPEAK_EDIT_VIEW = "offpeak-edit-view";
export const TID_OFFPEAK_EDIT_SUBMIT = "offpeak-edit-submit";
export const TID_OFFPEAK_FORM_TITLE = "offpeak-form-title";
export const TID_OFFPEAK_FORM_INSTRUCTIONS = "offpeak-form-instructions";
export const TID_OFFPEAK_ACTION_PAUSE = "offpeak-action-pause";
export const TID_OFFPEAK_ACTION_CONTINUE = "offpeak-action-continue";
export const TID_OFFPEAK_ACTION_DELETE = "offpeak-action-delete";
export const TID_OFFPEAK_TAB = "offpeak-tab";
export const TID_AUTOMATION_CARD_MENU = "automation-card-menu";
export const TID_AUTOMATION_ACTION_TOGGLE = "automation-action-toggle";
export const TID_AUTOMATION_ACTION_DELETE = "automation-action-delete";
export const TID_AUTOMATION_FORM_TITLE = "automation-form-title";
export const TID_AUTOMATION_FORM_PROMPT = "automation-form-prompt";
export const TID_AUTOMATION_FORM_SUBMIT = "automation-form-submit";
export const TID_AUTOMATION_RUN_NOW = "automation-run-now";
export const TID_AUTOMATION_EDIT_BACK = "automation-edit-back";
// 调度 builder / 自定义重复 / 年度月日选择器（e2e 稳定锚点）
export const TID_AUTOMATION_FREQUENCY_SELECT = "automation-frequency-select";
export const TID_AUTOMATION_FREQUENCY_OPTION = "automation-frequency-option";
export const TID_AUTOMATION_CUSTOM_UNIT_SELECT = "automation-custom-unit-select";
export const TID_AUTOMATION_CUSTOM_UNIT_OPTION = "automation-custom-unit-option";
export const TID_AUTOMATION_CUSTOM_INTERVAL_SELECT = "automation-custom-interval-select";
export const TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT = "automation-custom-interval-increment";
export const TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT = "automation-custom-interval-decrement";
export const TID_AUTOMATION_CUSTOM_INTERVAL_OPTION = "automation-custom-interval-option";
export const TID_AUTOMATION_CUSTOM_REPEAT_EDIT = "automation-custom-repeat-edit";
export const TID_AUTOMATION_CUSTOM_CONFIRM = "automation-custom-confirm";
export const TID_AUTOMATION_YEAR_MONTHDAY = "automation-year-monthday";
export const TID_AUTOMATION_YEAR_MONTH_OPTION = "automation-year-month-option";
export const TID_AUTOMATION_YEAR_DAY_OPTION = "automation-year-day-option";
export const TID_AUTOMATION_SCHEDULE_PREVIEW = "automation-schedule-preview";
export const TID_AUTOMATION_SCHEDULE_ADD = "automation-schedule-add";
export const TID_AUTOMATION_SCHEDULE_DELETE = "automation-schedule-delete";
export const TID_CRON_CREATE_CARD = "cron-create-card";
export const TID_CRON_CREATE_OPEN = "cron-create-open";
export const TID_OFFPEAK_CREATE_CARD = "offpeak-create-card";
export const TID_OFFPEAK_CREATE_OPEN = "offpeak-create-open";
