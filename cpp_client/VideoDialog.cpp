#include "VideoDialog.h"
#include <QMessageBox>
#include <QFormLayout>

VideoDialog::VideoDialog(const QJsonObject& alert, ApiClient* client, QWidget *parent)
    : QDialog(parent), m_alert(alert), m_client(client) {
    setupUi();
    
    // Auto-play the video clip if available
    QString clipUrl = m_alert["clip_url"].toString();
    if (!clipUrl.isEmpty()) {
        m_player->setMedia(QUrl(m_client->getBaseUrl() + clipUrl));
        m_player->play();
    }
}

VideoDialog::~VideoDialog() {
    m_player->stop();
}

void VideoDialog::setupUi() {
    setWindowTitle("Alert Investigation - " + m_alert["transaction_id"].toString());
    setMinimumSize(800, 600);
    
    QVBoxLayout* mainLayout = new QVBoxLayout(this);
    
    // Video section
    m_videoWidget = new QVideoWidget(this);
    m_videoWidget->setMinimumSize(640, 480);
    mainLayout->addWidget(m_videoWidget);
    
    m_player = new QMediaPlayer(this);
    m_player->setVideoOutput(m_videoWidget);
    connect(m_player, QOverload<QMediaPlayer::Error>::of(&QMediaPlayer::error), this, [this](QMediaPlayer::Error error) {
        if (error != QMediaPlayer::NoError) {
            QMessageBox::warning(this, "Media Playback Error", "Error playing video: " + m_player->errorString());
        }
    });
    
    // Video controls
    QHBoxLayout* controlsLayout = new QHBoxLayout();
    QPushButton* btnPlay = new QPushButton("Play");
    QPushButton* btnPause = new QPushButton("Pause");
    connect(btnPlay, &QPushButton::clicked, m_player, &QMediaPlayer::play);
    connect(btnPause, &QPushButton::clicked, m_player, &QMediaPlayer::pause);
    controlsLayout->addWidget(btnPlay);
    controlsLayout->addWidget(btnPause);
    mainLayout->addLayout(controlsLayout);
    
    // Alert info
    QFormLayout* formLayout = new QFormLayout();
    formLayout->addRow("Action:", new QLabel(m_alert["action_type"].toString()));
    formLayout->addRow("Counter:", new QLabel(m_alert["counter_id"].toString()));
    formLayout->addRow("Risk Score:", new QLabel(m_alert["risk_score"].toString()));
    formLayout->addRow("AI Flag:", new QLabel(m_alert["flag"].toString()));
    mainLayout->addLayout(formLayout);
    
    // Remarks
    mainLayout->addWidget(new QLabel("Auditor Remarks:"));
    m_remarksEdit = new QTextEdit(this);
    m_remarksEdit->setMaximumHeight(80);
    mainLayout->addWidget(m_remarksEdit);
    
    // Disposition Buttons
    QHBoxLayout* btnLayout = new QHBoxLayout();
    m_btnClean = new QPushButton("Verified Clean");
    m_btnDiscrepancy = new QPushButton("Verified Discrepancy");
    m_btnEscalate = new QPushButton("Escalate to Risk");
    
    m_btnClean->setStyleSheet("background-color: #10b981; color: white; font-weight: bold; padding: 8px;");
    m_btnDiscrepancy->setStyleSheet("background-color: #f59e0b; color: white; font-weight: bold; padding: 8px;");
    m_btnEscalate->setStyleSheet("background-color: #ef4444; color: white; font-weight: bold; padding: 8px;");
    
    btnLayout->addWidget(m_btnClean);
    btnLayout->addWidget(m_btnDiscrepancy);
    btnLayout->addWidget(m_btnEscalate);
    mainLayout->addLayout(btnLayout);
    
    connect(m_btnClean, &QPushButton::clicked, this, &VideoDialog::submitClean);
    connect(m_btnDiscrepancy, &QPushButton::clicked, this, &VideoDialog::submitDiscrepancy);
    connect(m_btnEscalate, &QPushButton::clicked, this, &VideoDialog::submitEscalate);
}

void VideoDialog::submitClean() { submitDisposition("Verified-Clean"); }
void VideoDialog::submitDiscrepancy() { submitDisposition("Verified-Discrepancy"); }
void VideoDialog::submitEscalate() { submitDisposition("Escalated"); }

void VideoDialog::submitDisposition(const QString& outcome) {
    m_client->saveDisposition(m_alert["id"].toInt(), outcome, m_remarksEdit->toPlainText());
    accept();
}
