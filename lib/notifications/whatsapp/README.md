# WhatsApp notification provider

Sits next to SendGrid in the notification layer. Locally and until real BSP
credentials exist, `WHATSAPP_BSP_PROVIDER=mock`. Planned production provider:
360Dialog — activating it is configuration only:

```bash
WHATSAPP_BSP_PROVIDER=mock            # → 360dialog later, zero code changes
WHATSAPP_BSP_API_KEY=PLACEHOLDER_360DIALOG_KEY
WHATSAPP_BSP_BASE_URL=PLACEHOLDER
WHATSAPP_BUSINESS_PHONE_ID=PLACEHOLDER
WHATSAPP_WEBHOOK_VERIFY_TOKEN=PLACEHOLDER
```
