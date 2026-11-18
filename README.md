# Süper Lig Alan Savaşı — TikTok Live Oyunu

TikTok canlı yayınları için geliştirilmiş gerçek zamanlı **4 takımlı (BJK, FB, GS, TS)** interaktif **Alan Savaşı (Territory War)** oyunu. İzleyiciler sohbete takım kodunu yazarak veya hediye göndererek takımları adına sahaya top çıkarır; alanın %100'ünü ele geçiren takım turu kazanır.

## Özellikler

- **9:16 Dikey Yayın Tasarımı:** TikTok Live ve OBS dikey sahne (1080×1920) ile uyumlu arayüz.
- **Sohbet & Hediye Entegrasyonu:** `tiktok-live-connector` üzerinden canlı sohbet ve hediye serilerini (streak) destekler.
- **Jeton Bazlı Top Hesaplama:** Gönderilen hediyenin jeton değerine göre dengeli top sayısı üretir.
- **Yönetim & Test Paneli (`/admin`):** Canlı yayına bağlanma, yorum/hediye simülasyonu ve yeni tur başlatma.
- **Kalıcı Şampiyonluk Sayacı:** Takım galibiyetleri `server/wins.json` dosyasında saklanır.

## Kurulum

**Gereksinimler:** Node.js 18+

```bash
npm install
```

## Çalıştırma

```bash
npm start
```

Sunucu varsayılan olarak `3000` portunda başlar:
- **Oyun Ekranı (OBS / Tarayıcı):** `http://localhost:3000`
- **Yönetim & Test Paneli:** `http://localhost:3000/admin`

### Ortam Değişkenleri (Opsiyonel)

- `PORT`: Sunucu portunu değiştirir (varsayılan: `server/config.json` içindeki `3000`).
- `ADMIN_TOKEN`: Belirlendiğinde admin API ve WebSocket komutları için token doğrulaması ister. Tarayıcıda hem admin (`/admin?token=SIFRENIZ`) hem de galibiyetlerin kaydedilmesi için oyun ekranı (`/?token=SIFRENIZ`) URL'sine parametre olarak eklenmelidir.

## Testler

```bash
npm test
```

Birim testlerini ve gerçek HTTP/WebSocket sunucu entegrasyon testini çalıştırır.

## Lisans

[MIT](LICENSE)
