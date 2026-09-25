QT += core gui widgets network multimedia multimediawidgets

CONFIG += c++11

TARGET = SmartCareClient
TEMPLATE = app

SOURCES += main.cpp \
           MainWindow.cpp \
           ApiClient.cpp \
           VideoDialog.cpp

HEADERS += MainWindow.h \
           ApiClient.h \
           VideoDialog.h
