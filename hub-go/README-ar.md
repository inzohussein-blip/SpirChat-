# المحطة الخفيفة (Go) — لراوترات OpenWrt الرخيصة

نسخة ثانية من برنامج المحطة، تؤدي العمل نفسه، لكن:
- **ملف تنفيذي واحد** بحجم 7–8 MB تقريباً.
- **دون Node.js ودون قاعدة بيانات**، فتعمل على راوتر سعره 25–40 دولاراً بدل Raspberry Pi.
- **تتكلم البروتوكول نفسه**، ويمكن مزجها مع محطات Node في الشبكة نفسها.
- **تقرأ إعدادات البيئة نفسها**: `HUB_NAME` و `PEERS` و `ALERT_KEYS` و `HUB_AREA` و `CAPTIVE` وغيرها
  (انظر [دليل المحطة](../docs/hub-setup-ar.md)).

> **كيف نعرف أنها تطابق المحطة الأصلية؟** كل اختبارات المتصفح الكاملة تُشغَّل في GitHub على المحطتين.

## اختيار الراوتر

| المطلوب | لماذا |
|---|---|
| OpenWrt 23.05 أو أحدث | نظام مفتوح المصدر للراوترات |
| ذاكرة 128 MB أو أكثر | 64 MB تكفي لمحطة صغيرة، مع `MAX_STORE_MB=32` |
| **منفذ USB** مع فلاشة | ذاكرة الراوتر الداخلية (16 MB غالباً) لا تتسع للبرنامج والبيانات معاً |
| معالج MediaTek MT7621 أو MT7628 أو ARM | أمثلة: Xiaomi 4A Gigabit، و GL.iNet، و TP-Link Archer C6 |

## التركيب

1. نزّل الملف المناسب لمعالج الراوتر من صفحة **Actions** على GitHub (حزمة **SpirChat-hub-go**)،
   أو ابنِه بنفسك بالأمر `./hub-go/build.sh`.
2. انسخ البرنامج وتطبيق الويب إلى الفلاشة الموصولة بالراوتر:

```bash
scp spirchat-hub-linux-mipsle root@192.168.1.1:/mnt/usb/spirchat-hub
scp -r web/dist root@192.168.1.1:/mnt/usb/web
```

3. على الراوتر، أنشئ خدمة `/etc/init.d/spirchat`:

```sh
#!/bin/sh /etc/rc.common
START=99
USE_PROCD=1
start_service() {
  procd_open_instance
  procd_set_param command /mnt/usb/spirchat-hub
  procd_set_param env PORT=8080 HUB_NAME=Karrada-1 DATA_DIR=/mnt/usb/data WEB_DIR=/mnt/usb/web CAPTIVE=1 MAX_STORE_MB=512
  procd_set_param respawn
  procd_close_instance
}
```

```sh
chmod +x /etc/init.d/spirchat && /etc/init.d/spirchat enable && /etc/init.d/spirchat start
```

4. اجعل اسم شبكة الواي فاي `SpirChat` ومفتوحة، ووجّه كل أسماء النطاقات إلى الراوتر لتعمل البوابة المقيدة:

```sh
uci set dhcp.@dnsmasq[0].address='/#/192.168.1.1'
uci commit dhcp && /etc/init.d/dnsmasq restart
```

ثم وجّه المنفذ 80 إلى المحطة (أو شغّلها على 80 بعد نقل واجهة إدارة الراوتر إلى منفذ آخر).

> ⚠️ هذه الخطوات **لم تُجرَّب على راوتر حقيقي** بعد، وقد تحتاج تعديلاً حسب الطراز. البرنامج نفسه مختبَر
> على حاسوب بكل اختبارات المشروع.

## الفروقات عن محطة Node

- **التخزين:** سجل نصي يُضاف إليه فقط، مع فهرس في الذاكرة، بدل SQLite. السجل يُضغط تلقائياً كل دقيقة،
  وعند الامتلاء تُحذف الصور والمنشورات الأقل أهمية أولاً.
- **الحد الافتراضي للتخزين:** 256 MB بدل 2 GB.
- **حالة نادرة:** النصوص التي تحوي «أنصاف رموز» UTF-16 منفردة (لا تنتجها أي واجهة عادية) تُرفض هنا وتُقبل في
  محطة Node.
