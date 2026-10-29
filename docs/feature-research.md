# İlgili projeler ve özellik karşılaştırması

10 Ekim 2026 tarihinde canlı GitHub kaynakları incelendi. Karşılaştırma README, ilgili kod ve lisans dosyalarına dayanır; diğer projeler çalıştırılmadı ve doğruluk/hız iddiaları bağımsız ölçülmedi. Aşağıdaki bağlantılar incelenen commitleri sabitler. Harici kod, veri seti veya model ağırlığı bu depoya kopyalanmadı.

## İncelenen kaynaklar

| Proje | Kaynakta görülen özellik | Başlangıç sürümümüzle fark | Lisans gözlemi |
| --- | --- | --- | --- |
| [Frigate](https://github.com/blakeblackshear/frigate/tree/01f33696591d84b44c5fc397de513db567080b56) | [Çokgen bölgeler](https://github.com/blakeblackshear/frigate/blob/01f33696591d84b44c5fc397de513db567080b56/docs/docs/configuration/zones.md), [kamera metrikleri](https://github.com/blakeblackshear/frigate/blob/01f33696591d84b44c5fc397de513db567080b56/docs/docs/configuration/metrics.md), [geçmiş filtreleri ve olay gruplama](https://github.com/blakeblackshear/frigate/blob/01f33696591d84b44c5fc397de513db567080b56/docs/docs/configuration/review.md) | Bölge seçimi, gerçek performans bilgisi, tarih/kamera/tür filtreleri ve olay yaşam döngüsü yoktu | MIT; marka hakları ayrı |
| [Supervision](https://github.com/roboflow/supervision/tree/0802a0e79ae097bfaad45a65f94cba9a2ae2a1c2) | [PolygonZone ve kutu referans noktası seçimi](https://github.com/roboflow/supervision/blob/0802a0e79ae097bfaad45a65f94cba9a2ae2a1c2/src/supervision/detection/tools/polygon_zone.py) | Tüm görüntü alarm üretebiliyordu | MIT |
| [YOLOv10 Fire and Smoke Detection](https://github.com/X-Men01/YOLOv10-Fire-and-Smoke-Detection/blob/7aa87d005726fdd10da0b453b1d6ab91c6d339a4/demo/app.py) | Görüntü yükleme, işaretlenmiş sonuç, güven/IoU/çıkarım boyutu ayarları | Görüntü analizi ekranı ve IoU ayarı yoktu; çıkarım güven eşiği sabitti | Kök dizinde kod lisansı bulunmadı |
| [Flare Guard](https://github.com/sayedgamal99/Real-Time-Smoke-Fire-Detection-YOLO11/blob/4be332a4316b94b505672b9716aad738e171097a/src/fire_detector.py) | Yangın ve duman için ayrı eşikler; [çoklu bildirim alıcısı ve WhatsApp](https://github.com/sayedgamal99/Real-Time-Smoke-Fire-Detection-YOLO11/blob/4be332a4316b94b505672b9716aad738e171097a/src/notification_service.py) | Tek ortak güven eşiği ve tek Telegram alıcısı vardı; WhatsApp yoktu | Kök dizinde kod lisansı bulunmadı |
| [Fire-Detection](https://github.com/pedbrgs/Fire-Detection/blob/9d99b0e71fd4cc930da053a41b79de1c58aabdf2/temporal/tracker.py) | Nesne takibi, konuma ve kutu alanı değişimine dayalı zamansal doğrulama | Yalnız sınıf bazlı kare sayacı vardı | MIT |
| [YOLOv8 Fire and Smoke Detection](https://github.com/Abonia1/YOLOv8-Fire-and-Smoke-Detection/blob/f2c67efae8ff249f2c3e1c34df0fd3a6351a1efb/train-yolov8-early-fire%26smoke-detection-on-custom-dataset.ipynb) | Eğitim/validation notebooku, yerel resim ve MP4 çıkarımı | Tekrar üretilebilir eğitim ve dosya analizi akışı yoktu | Kod lisansı bulunmadı; veri tanımı CC BY 4.0 bildiriyor |
| [DFireDataset](https://github.com/gaia-solutions-on-demand/DFireDataset/blob/4bf9c31b18fadcd44d5f0b6d66f82bc56fa5e328/README.md) | README'de yangın, duman ve negatif örnekler ile veri bölümleri; YOLO koordinat araçları | Duman eğitimi ve etiketli yanlış alarm değerlendirmesi yoktu | CC0 1.0; veri indirilmedi |

Çoklu kamera, SQLite, WebSocket, Telegram/e-posta, arka planda bildirim gönderimi ve temel kare doğrulaması bizde zaten vardı. Bunlar yeni özellik olarak sayılmadı. CSV dışa aktarma, doğrulanmış geçmiş filtrelerini tamamlayan kendi geliştirmemizdir; incelenen kaynaklarda CSV bulunduğu iddia edilmiyor.

## Bu pakette uygulananlar

- Kamera başına kalıcı çokgen alarm bölgesi. Kutunun merkezi bölge içindeyse alarm politikası uygulanır; boş bölge tüm görüntüyü kapsar.
- Gerçek çıkarıma uygulanan güven/IoU ayarları ve yangın/duman sınıf eşikleri. Boş sınıf eşiği ortak değeri kullanır.
- Ardışık işlenmiş kare doğrulaması: aynı karedeki çoklu kutular tek kare sayılır, yüksek güven doğrulamayı atlamaz ve eşik/bölge dışı sonuçlar sürekliliği sıfırlar. Algılama ayarları değiştiğinde doğrulama yeni ayarlarla baştan başlar; alarm bekleme süresi korunur.
- Olaylarda kalıcı kamera adı ve kimliği; tarih/tür/kamera/güven filtreleri, sayfalama ve aynı filtrelerle CSV indirme.
- Kamera başına işlenen kare sayısı, ölçülen işlem FPS'i ve çıkarım süresi; tek kameradaki çıkarım hatası diğer kameraların döngüsünü durdurmaz.
- Görüntü yükleme ve analiz: işaretlenmiş sonuç, kutular ve güven değerleri. Bu işlem kamera olayı veya bildirim oluşturmaz.
- Modelin gerçek sınıflarının görünmesi ve `FIRE_MODEL_PATH` ile yerel model seçimi. Birlikte gelen model yalnız `Fire` içerir; bu paket duman eğitimi yapmaz.
- Yerel fontlar, dış ses dosyasına ihtiyaç duymayan alarm ve doğru günlük olay sayısı.

Mevcut veritabanı yerinde, alan ekleyen göçlerle korunur. Kamera bilgisi olmayan eski olaylar erişilebilir kalır. SQLite WAL kullanımı, açık CSV dışa aktarımı sürerken yeni olayların kaydedilmesini sağlar. Algılama sonuçları model doğruluğunun garantisi değildir; bu paketin testleri işlev ve alarm politikası davranışını doğrular.

## Sonraki geliştirmeler

| Özellik | Kalan iş |
| --- | --- |
| Dumanı gerçekten algılayan model | İzinli veri ve model, tekrar üretilebilir eğitim, sınıf bazlı precision/recall ve negatif görüntü değerlendirmesi |
| Video yükleme ve dosya çıktısı | Kuyruk, ilerleme, iptal, kaynak sınırları ve çıktı video yönetimi |
| Nesne bazlı takip ve alan değişimi doğrulaması | Ayrı nesnelerin karışmasını önleyen takip, gerçek video ile yanlış alarm kıyaslaması |
| Olay yaşam döngüsü ve onaylama | Başlangıç/son görülme/bitiş, aynı olayı birleştirme, kullanıcı onayı |
| Olay öncesi/sonrası video ve saklama süresi | Sınırlı kayıt tamponu, disk sınırları, güvenli saklama temizliği |
| Çoklu alıcı ve ek bildirim kanalları | Sağlayıcı ayrımı, gönderim kaydı, kontrollü tekrar deneme ve kullanıcı tarafından yapılandırılmış gerçek bağlantı testleri |

Bu işler tamamlanmış olarak sunulmuyor. Özellikle başka depodaki bir ağırlığın bulunması, duman algılamasının hazır veya doğruluğunun yeterli olduğu anlamına gelmez.
